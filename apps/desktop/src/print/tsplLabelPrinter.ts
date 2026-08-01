import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, screen } from 'electron'
import { calculateBarcodeCanvasGeometry } from './tsplBarcodeRaster'
import { enqueuePrinterJob } from './printerJobQueue'
import { assertPrinterRole } from './printerRole'
import { withPrintTimeout } from './printTimeout'

// Прямий друк етикеток мовою TSPL (термопринтери типу PS-HL80, Xprinter тощо).
//
// Навіщо: друк через Windows-драйвер растеризує сторінку у 96 dpi і масштабує
// на 203 dpi термоголовку — драйвер дизерить антиаліасинг у «зерно», штрихи
// коду розпливаються. Тут ми рендеримо етикетку офскрін РІВНО у 8 крапок/мм
// (203.2 dpi), самі бінаризуємо без дизерингу і шлемо принтеру готовий бітмап
// RAW-потоком повз рендер драйвера. Важливо: друкуємо саме готовий
// HTML-макет цілком, щоб фактична етикетка збігалася з дизайнером.

export interface TsplPrintOptions {
  printerName: string
  widthMm: number
  heightMm: number
  /** Зазор між етикетками на рулоні, мм (типово 2-3). */
  gapMm?: number
  /** Щільність нагріву 0..15 (типово 8-10). */
  density?: number
  /** Розвернути друк на 180° (якщо етикетки виходять догори ногами). */
  rotate180?: boolean
}

interface BarcodeMeta {
  id: string
  code: string
  pattern: string
  quietRatio: number
  width: number
  height: number
}

interface BarcodeCanvasSpec {
  id: string
  pattern: string
  widthDots: number
  heightDots: number
  quietZoneDots: number
}

interface PageMeta {
  index: number
  width: number
  height: number
  barcodes: BarcodeMeta[]
}

/** TSPL для 203 dpi: рівно 8 крапок на мм. */
const DOTS_PER_MM = 8
/** CSS-піксель = 1/96 дюйма; зум, за якого 1мм контенту = 8 фізичних px. */
const ZOOM = DOTS_PER_MM / (96 / 25.4)

function sanitizeMm(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

// ────────────────────────── RAW у спулер Windows ──────────────────────────

// Статуси спулера, за яких завдання нікуди не поїде: принтер відвалився по USB,
// скінчились етикетки, відкрита кришка. Windows не прибирає такі завдання сам —
// вони лишаються Retained і мовчки блокують ВСІ наступні друки.
const FATAL_JOB_PATTERN = 'Error|Offline|PaperOut|UserIntervention'
const NOT_READY_PATTERN = 'Error|Offline|PaperOut|PaperProblem|NotAvailable|Unavailable'
// Blocked у Windows для RAW/USB-принтерів може бути коротким перехідним станом.
// Його не можна одразу знімати з черги: так програма сама скасовувала живий друк.
// Найпідступніше зависання не має статусу помилки взагалі: `Printing, Retained`
// з PagesPrinted=0, яке висить годинами. Ловимо його за віком і відсутністю
// прогресу — інакше воно блокує чергу непоміченим.
const IN_FLIGHT_JOB_PATTERN = 'Printing|Retained|Deleting|Spooling'
const STALE_JOB_SECONDS = 90

const RAW_PRINT_SCRIPT = String.raw`
param([string]$PrinterName, [string]$DocumentName)
$ErrorActionPreference = 'Stop'

$docName = $DocumentName
$fatalPattern = '${FATAL_JOB_PATTERN}'
$inFlightPattern = 'Blocked|${IN_FLIGHT_JOB_PATTERN}'
$staleSeconds = ${STALE_JOB_SECONDS}

function Get-StuckJobs {
  $now = Get-Date
  @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue | Where-Object {
    $_.JobStatus -match $fatalPattern -or (
      $_.JobStatus -match $inFlightPattern -and
      $_.PagesPrinted -eq 0 -and
      $_.SubmittedTime -and
      ($now - $_.SubmittedTime).TotalSeconds -gt $staleSeconds
    )
  })
}

# ── Preflight ────────────────────────────────────────────────────────────────
# Спершу прибираємо чужий мотлох із черги, і лише потім дивимось на статус
# принтера: залипле завдання саме по собі виставляє принтеру стан Error.
try {
  # @() обов'язкове: Windows PowerShell 5.1 розгортає одноелементний масив при
  # поверненні з функції, і тоді .Count дає $null — саме випадок «залип рівно
  # один job», тобто найчастіший. Без обгортки перевірка мовчки пропускала його.
  $stuck = @(Get-StuckJobs)
  if ($stuck.Count -gt 0) {
    $stuck | Remove-PrintJob -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
    if (@(Get-StuckJobs).Count -gt 0) { throw 'TSPL_QUEUE_STUCK' }
  }
  $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
  # Під час пакетного друку USB-принтер часто дає КОРОТКОЧАСНИЙ not-ready між
  # завданнями (Offline/NotAvailable на частку секунди), а друк потім іде нормально.
  # Тому не кидаємо помилку одразу: перевіряємо статус кілька разів. Реальний обрив
  # кабелю/скінчена стрічка лишаються not-ready і після повторів — тоді помилка.
  $tries = 0
  while ($printer -and ($printer.PrinterStatus -match '${NOT_READY_PATTERN}') -and $tries -lt 4) {
    Start-Sleep -Milliseconds 400
    $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
    $tries++
  }
  if ($printer -and ($printer.PrinterStatus -match '${NOT_READY_PATTERN}')) {
    throw "TSPL_PRINTER_NOT_READY: $($printer.PrinterStatus)"
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  # Немає модуля PrintManagement — друкуємо без перевірки, як раніше.
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ForsageRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv")] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFO di);
  [DllImport("winspool.Drv")] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv")] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv")] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
}
"@
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
if ($data.Length -eq 0) { throw 'RAW_PRINT_EMPTY' }
$h = [IntPtr]::Zero
if (-not [ForsageRawPrint]::OpenPrinter($PrinterName, [ref]$h, [IntPtr]::Zero)) {
  throw "RAW_PRINT_OPEN_FAILED: $PrinterName"
}
try {
  $di = New-Object ForsageRawPrint+DOCINFO
  $di.pDocName = $docName
  $di.pDataType = 'RAW'
  if (-not [ForsageRawPrint]::StartDocPrinter($h, 1, $di)) { throw 'RAW_PRINT_STARTDOC_FAILED' }
  [void][ForsageRawPrint]::StartPagePrinter($h)
  $written = 0
  if (-not [ForsageRawPrint]::WritePrinter($h, $data, $data.Length, [ref]$written)) { throw 'RAW_PRINT_WRITE_FAILED' }
  if ($written -ne $data.Length) { throw "RAW_PRINT_INCOMPLETE: $written/$($data.Length)" }
  [void][ForsageRawPrint]::EndPagePrinter($h)
  [void][ForsageRawPrint]::EndDocPrinter($h)
} finally {
  [void][ForsageRawPrint]::ClosePrinter($h)
}

# ── Postflight ───────────────────────────────────────────────────────────────
# WritePrinter вважається успішним, щойно байти лягли у спулер — навіть якщо
# принтера фізично немає. Тому чекаємо, поки завдання реально піде з черги.
# Черга спорожніла = надруковано; статус помилки = ні. Якщо ж воно й далі
# спокійно друкується (велика партія), мовчки виходимо з успіхом.
try {
  $deadline = (Get-Date).AddSeconds(15)
  $failure = $null
  while ((Get-Date) -lt $deadline) {
    $mine = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue |
      Where-Object { $_.DocumentName -eq $docName })
    if ($mine.Count -eq 0) { break }
    $bad = @($mine | Where-Object { $_.JobStatus -match $fatalPattern })
    if ($bad.Count -gt 0) { $failure = $bad[0].JobStatus; break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $failure) {
    $left = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue |
      Where-Object { $_.DocumentName -eq $docName })
    if ($left.Count -gt 0) {
      $active = @($left | Where-Object { $_.PagesPrinted -gt 0 })
      if ($active.Count -eq 0) { $failure = $left[0].JobStatus }
    }
  }
  if ($failure) {
    Get-StuckJobs | Where-Object { $_.DocumentName -eq $docName } |
      Remove-PrintJob -Confirm:$false -ErrorAction SilentlyContinue
    throw "TSPL_PRINT_NOT_CONFIRMED: $failure"
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  # Немає модуля PrintManagement — покладаємось на результат WritePrinter.
}

[Console]::Out.Write('RAW_PRINT_OK')
`

function sendRawToPrinter(printerName: string, data: Buffer, signal: AbortSignal): Promise<void> {
  const scriptPath = path.join(app.getPath('userData'), 'raw-print.ps1')
  fs.writeFileSync(scriptPath, RAW_PRINT_SCRIPT, 'utf8')
  const documentName = `Forsage-label-${randomUUID().slice(0, 8)}`

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('TSPL_PRINT_ABORTED'))
      return
    }

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-PrinterName', printerName,
      '-DocumentName', documentName,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const abort = () => {
      try { ps.kill() } catch { /* already stopped */ }
      fail(new Error('TSPL_PRINT_ABORTED'))
    }

    ps.stdout.on('data', (chunk) => { stdout += String(chunk) })
    ps.stderr.on('data', (chunk) => { stderr += String(chunk) })
    ps.on('error', fail)
    ps.stdin.on('error', fail)
    signal.addEventListener('abort', abort, { once: true })

    // Із запасом на preflight (~1.5с) і очікування підтвердження друку (до 15с).
    timeout = setTimeout(() => {
      try { ps.kill() } catch { /* already stopped */ }
      fail(new Error('RAW_PRINT_TIMEOUT'))
    }, 60_000)

    ps.on('close', (exitCode) => {
      if (exitCode === 0 && stdout.includes('RAW_PRINT_OK')) succeed()
      else fail(new Error(stderr.trim() || stdout.trim() || `RAW_PRINT_EXIT_${exitCode}`))
    })

    try {
      ps.stdin.end(data.toString('base64'))
    } catch (error) {
      fail(error)
    }
  })
}

// ────────────────────────── Рендер HTML → 1-bit бітмап ──────────────────────────

/**
 * BGRA-кадр → 1-bit рядки TSPL BITMAP (біт 1 = білий, 0 = чорний).
 * Поріг замість дизерингу: сірий текст (#555) стає суцільно чорним,
 * фон — чисто білим, жодного «зерна». strideWidth — фактична ширина кадру,
 * width/height — скільки крапок вирізати під етикетку.
 */
async function toMonochrome(
  bgra: Buffer,
  strideWidth: number,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const bytesPerRow = Math.ceil(width / 8)
  const bits = Buffer.alloc(bytesPerRow * height, 0xff)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * strideWidth * 4
    const outOffset = y * bytesPerRow
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * 4
      const luma256 = 29 * bgra[i] + 150 * bgra[i + 1] + 77 * bgra[i + 2]
      if (luma256 < 160 * 256) bits[outOffset + (x >> 3)] &= ~(0x80 >> (x & 7))
    }
    // Велика партія не повинна блокувати Electron main thread. Віддаємо цикл
    // подій після невеликого шматка рядків, не змінюючи жодного пікселя.
    if ((y & 31) === 31) {
      if (signal.aborted) throw new Error('TSPL_PRINT_ABORTED')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return bits
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function buildBarcodeCanvasSpecs(
  page: PageMeta,
  widthDots: number,
  heightDots: number,
): BarcodeCanvasSpec[] {
  if (!Array.isArray(page.barcodes) || page.barcodes.length === 0) return []

  const pageWidth = Number(page.width) || widthDots
  const pageHeight = Number(page.height) || heightDots
  const scaleX = widthDots / Math.max(1, pageWidth)
  const scaleY = heightDots / Math.max(1, pageHeight)

  return page.barcodes.map((barcode) => {
    const geometry = calculateBarcodeCanvasGeometry({
      pattern: barcode.pattern,
      rectWidth: barcode.width,
      rectHeight: barcode.height,
      quietRatio: barcode.quietRatio,
      scaleX,
      scaleY,
    })
    if (!geometry.ok) {
      if (geometry.reason === 'too-narrow') {
        const code = barcode.code ? ` «${barcode.code}»` : ''
        throw new Error(
          `TSPL_BARCODE_TOO_NARROW|Штрих-код${code} занадто вузький для надійного друку. `
          + `Збільште його ширину в дизайнері етикетки щонайменше до ${geometry.requiredWidthDots} точок.`,
        )
      }
      throw new Error('TSPL_BARCODE_PATTERN_INVALID')
    }

    return {
      id: barcode.id,
      pattern: barcode.pattern,
      widthDots: geometry.widthDots,
      heightDots: geometry.heightDots,
      quietZoneDots: geometry.quietZoneDots,
    }
  })
}

function buildPreparePageScript(pageIndex: number, specs: BarcodeCanvasSpec[]): string {
  return `
    (() => {
      const labelPages = Array.from(document.querySelectorAll('.label-page'))
      labelPages.forEach((candidate, index) => {
        candidate.style.display = index === ${pageIndex} ? 'block' : 'none'
      })

      const specs = ${JSON.stringify(specs)}
      const images = Array.from(document.querySelectorAll('img.barcode-raster[data-print-barcode-id], svg.barcode-vector[data-print-barcode-id]'))
      for (const spec of specs) {
        const image = images.find((candidate) => candidate.getAttribute('data-print-barcode-id') === spec.id)
        if (!image) throw new Error('TSPL_BARCODE_IMAGE_NOT_FOUND')

        const rect = image.getBoundingClientRect()
        const computed = window.getComputedStyle(image)
        const canvas = document.createElement('canvas')
        for (const attribute of Array.from(image.attributes)) {
          if (attribute.name === 'src' || attribute.name === 'width' || attribute.name === 'height') continue
          canvas.setAttribute(attribute.name, attribute.value)
        }
        canvas.width = spec.widthDots
        canvas.height = spec.heightDots
        canvas.style.width = rect.width + 'px'
        canvas.style.height = rect.height + 'px'
        canvas.style.maxWidth = 'none'
        canvas.style.maxHeight = 'none'
        canvas.style.display = computed.display === 'inline' ? 'inline-block' : computed.display
        canvas.style.flex = computed.flex
        canvas.style.margin = computed.margin
        canvas.style.verticalAlign = computed.verticalAlign
        canvas.style.boxSizing = 'border-box'
        canvas.style.imageRendering = 'pixelated'

        const context = canvas.getContext('2d')
        if (!context) throw new Error('TSPL_BARCODE_CANVAS_UNAVAILABLE')
        context.imageSmoothingEnabled = false
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, spec.widthDots, spec.heightDots)
        context.fillStyle = '#000000'
        const barsWidth = spec.widthDots - spec.quietZoneDots * 2
        for (let moduleIndex = 0; moduleIndex < spec.pattern.length; moduleIndex += 1) {
          if (spec.pattern[moduleIndex] !== '1') continue
          const xStart = Math.round(spec.quietZoneDots + moduleIndex * barsWidth / spec.pattern.length)
          const xEnd = Math.round(spec.quietZoneDots + (moduleIndex + 1) * barsWidth / spec.pattern.length)
          context.fillRect(xStart, 0, xEnd - xStart, spec.heightDots)
        }

        image.replaceWith(canvas)
      }
      window.scrollTo(0, 0)
      return true
    })()
  `
}

const COLLECT_PAGES_SCRIPT = `
(() => Array.from(document.querySelectorAll('.label-page')).map((page, index) => {
  const pageRect = page.getBoundingClientRect()
  const barcodes = Array.from(page.querySelectorAll('img.barcode-raster[data-pattern], svg.barcode-vector[data-pattern]')).map((image, barcodeIndex) => {
    const rect = image.getBoundingClientRect()
    const id = index + ':' + barcodeIndex
    const declaredWidth = Number(image.getAttribute('width')) || rect.width
    const quietZone = Number(image.getAttribute('data-quiet-zone')) || 0
    const storedQuietRatio = image.hasAttribute('data-quiet-ratio')
      ? Number(image.getAttribute('data-quiet-ratio'))
      : Number.NaN
    const quietRatio = Number.isFinite(storedQuietRatio)
      ? storedQuietRatio
      : quietZone / Math.max(1, declaredWidth)
    image.setAttribute('data-print-barcode-id', id)
    return {
      id,
      code: image.getAttribute('data-code') || '',
      pattern: image.getAttribute('data-pattern') || '',
      quietRatio,
      width: rect.width,
      height: rect.height
    }
  })
  return { index, width: pageRect.width, height: pageRect.height, barcodes }
}))()
`

// ────────────────────────── Основний потік друку ──────────────────────────

type TsplPrintResult = { success: true; labels: number }
const activePrintJobs = new Map<string, Promise<TsplPrintResult>>()
const TSPL_TOTAL_TIMEOUT_MS = 180_000
const TSPL_RENDER_TIMEOUT_MS = 15_000
const TSPL_SCRIPT_TIMEOUT_MS = 10_000
const TSPL_CAPTURE_TIMEOUT_MS = 10_000

async function executeLabelsTsplCore(
  html: string,
  options: TsplPrintOptions,
  controller: AbortController,
): Promise<TsplPrintResult> {
  if (typeof html !== 'string' || html.trim().length === 0) throw new Error('PRINT_HTML_EMPTY')
  const printerName = String(options.printerName ?? '').trim()
  assertPrinterRole(printerName, 'label')

  const widthMm = sanitizeMm(options.widthMm, 40, 10, 120)
  const heightMm = sanitizeMm(options.heightMm, 30, 10, 120)
  const gapMm = sanitizeMm(options.gapMm, 2, 0, 10)
  const density = Math.round(sanitizeMm(options.density, 8, 0, 15))
  const widthDots = Math.round(widthMm * DOTS_PER_MM)
  const heightDots = Math.round(heightMm * DOTS_PER_MM)

  // Фізичний px = CSS px × zoom × системний масштаб дисплея. Компенсуємо
  // масштаб (125%/150% на Windows), щоб кадр вийшов РІВНО widthDots завширшки —
  // без жодного ресемплінгу.
  const scaleFactor = screen.getPrimaryDisplay()?.scaleFactor || 1
  const zoom = ZOOM / scaleFactor

  const renderWindow = new BrowserWindow({
    show: false,
    width: Math.ceil(widthDots / scaleFactor) + 2,
    height: Math.ceil(heightDots / scaleFactor) + 2,
    useContentSize: true,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const abortRender = () => {
    if (!renderWindow.isDestroyed()) renderWindow.destroy()
  }
  const stage = <T>(operation: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> =>
    withPrintTimeout(operation, timeoutMs, errorCode, () => controller.abort())
  controller.signal.addEventListener('abort', abortRender, { once: true })

  try {
    renderWindow.webContents.setFrameRate(30)
    renderWindow.webContents.startPainting()
    const encodedHtml = Buffer.from(html, 'utf8').toString('base64')
    await stage(
      renderWindow.loadURL(`data:text/html;charset=utf-8;base64,${encodedHtml}`),
      TSPL_RENDER_TIMEOUT_MS,
      'TSPL_RENDER_TIMEOUT',
    )
    renderWindow.webContents.setZoomFactor(zoom)
    // Скролбар не повинен звужувати фізичний макет етикетки.
    await stage(
      renderWindow.webContents.insertCSS(
        'html::-webkit-scrollbar{display:none} html{scrollbar-width:none} body{overflow:hidden}',
      ),
      TSPL_SCRIPT_TIMEOUT_MS,
      'TSPL_STYLE_TIMEOUT',
    )
    await stage(
      renderWindow.webContents.executeJavaScript(
        'Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => null))).then(() => true)',
        true,
      ),
      TSPL_SCRIPT_TIMEOUT_MS,
      'TSPL_RESOURCES_TIMEOUT',
    )
    await waitMs(150)

    const pages = await stage(
      renderWindow.webContents.executeJavaScript(COLLECT_PAGES_SCRIPT, true) as Promise<PageMeta[]>,
      TSPL_SCRIPT_TIMEOUT_MS,
      'TSPL_COLLECT_TIMEOUT',
    )
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('TSPL_NO_LABELS')

    const bytesPerRow = Math.ceil(widthDots / 8)
    const chunks: Buffer[] = []

    for (const page of pages) {
      if (controller.signal.aborted) throw new Error('TSPL_PRINT_ABORTED')
      const barcodeSpecs = buildBarcodeCanvasSpecs(page, widthDots, heightDots)
      await stage(
        renderWindow.webContents.executeJavaScript(
          buildPreparePageScript(page.index, barcodeSpecs),
          true,
        ),
        TSPL_SCRIPT_TIMEOUT_MS,
        'TSPL_PREPARE_PAGE_TIMEOUT',
      )
      await waitMs(60)

      const image = await stage(
        renderWindow.webContents.capturePage(),
        TSPL_CAPTURE_TIMEOUT_MS,
        'TSPL_CAPTURE_TIMEOUT',
      )
      const size = image.getSize()
      if (size.width < widthDots || size.height < heightDots) {
        throw new Error(`TSPL_CAPTURE_SIZE ${size.width}x${size.height} < ${widthDots}x${heightDots}`)
      }
      const bitmap = await toMonochrome(
        image.toBitmap(),
        size.width,
        widthDots,
        heightDots,
        controller.signal,
      )

      chunks.push(Buffer.from(
        `SIZE ${widthMm} mm,${heightMm} mm\r\n` +
        `GAP ${gapMm} mm,0 mm\r\n` +
        `DENSITY ${density}\r\n` +
        // DIRECTION 0 — правильна орієнтація на HL80 (з DIRECTION 1 друкував
        // догори ногами); rotate180 лишили як аварійний перемикач для інших.
        `DIRECTION ${options.rotate180 ? 1 : 0}\r\n` +
        `REFERENCE 0,0\r\n` +
        `CLS\r\n`,
        'ascii',
      ))
      chunks.push(Buffer.from(`BITMAP 0,0,${bytesPerRow},${heightDots},0,`, 'ascii'))
      chunks.push(bitmap.subarray(0, bytesPerRow * heightDots))
      chunks.push(Buffer.from('\r\n', 'ascii'))

      chunks.push(Buffer.from('PRINT 1,1\r\n', 'ascii'))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    const job = Buffer.concat(chunks)
    // Діагностика без принтера: FORSAGE_TSPL_DRY_RUN=шлях — скинути потік у файл
    const dryRunPath = process.env.FORSAGE_TSPL_DRY_RUN
    if (dryRunPath) {
      fs.writeFileSync(dryRunPath, job)
      return { success: true, labels: pages.length }
    }
    await stage(sendRawToPrinter(printerName, job, controller.signal), 65_000, 'RAW_PRINT_TIMEOUT')
    return { success: true, labels: pages.length }
  } finally {
    controller.signal.removeEventListener('abort', abortRender)
    if (!renderWindow.isDestroyed()) renderWindow.destroy()
  }
}

function executeLabelsTspl(html: string, options: TsplPrintOptions): Promise<TsplPrintResult> {
  const controller = new AbortController()
  const operation = Promise.resolve().then(() => executeLabelsTsplCore(html, options, controller))
  return withPrintTimeout(
    operation,
    TSPL_TOTAL_TIMEOUT_MS,
    'TSPL_TOTAL_TIMEOUT',
    () => controller.abort(),
  )
}

/** One live batch per POS-80; a repeated click shares that exact batch. */
export function printLabelsTspl(html: string, options: TsplPrintOptions): Promise<TsplPrintResult> {
  const printerName = String(options.printerName ?? '').trim()
  assertPrinterRole(printerName, 'label')
  const key = printerName.toLocaleLowerCase('en-US')
  const active = activePrintJobs.get(key)
  if (active) return active

  const job = enqueuePrinterJob(printerName, () => executeLabelsTspl(html, options))
  activePrintJobs.set(key, job)
  const release = () => {
    if (activePrintJobs.get(key) === job) activePrintJobs.delete(key)
  }
  job.then(release, release)
  return job
}
