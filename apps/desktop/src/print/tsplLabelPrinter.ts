import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, screen } from 'electron'

// Прямий друк етикеток мовою TSPL (термопринтери типу PS-HL80, Xprinter тощо).
//
// Навіщо: друк через Windows-драйвер растеризує сторінку у 96 dpi і масштабує
// на 203 dpi термоголовку — драйвер дизерить антиаліасинг у «зерно», штрихи
// коду розпливаються. Тут ми рендеримо етикетку офскрін РІВНО у 8 крапок/мм
// (203.2 dpi), самі бінаризуємо без дизерингу і шлемо принтеру готовий бітмап
// RAW-потоком повз рендер драйвера. Штрихкод друкує сам принтер рідною
// командою BARCODE — штрихи виходять крапка-в-крапку і читаються сканером.

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

interface PageBarcode {
  code: string
  modules: number
  x: number
  y: number
  w: number
  h: number
}

interface PageMeta {
  topCss: number
  barcodes: PageBarcode[]
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

const RAW_PRINT_SCRIPT = String.raw`
param([string]$PrinterName)
$ErrorActionPreference = 'Stop'
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
  $di.pDocName = 'Forsage labels (TSPL)'
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
[Console]::Out.Write('RAW_PRINT_OK')
`

function sendRawToPrinter(printerName: string, data: Buffer): Promise<void> {
  const scriptPath = path.join(app.getPath('userData'), 'raw-print.ps1')
  fs.writeFileSync(scriptPath, RAW_PRINT_SCRIPT, 'utf8')

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-PrinterName', printerName,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    ps.stdout.on('data', (chunk) => { stdout += String(chunk) })
    ps.stderr.on('data', (chunk) => { stderr += String(chunk) })
    ps.on('error', reject)

    const timeout = setTimeout(() => {
      ps.kill()
      reject(new Error('RAW_PRINT_TIMEOUT'))
    }, 30000)

    ps.on('close', (exitCode) => {
      clearTimeout(timeout)
      if (exitCode === 0 && stdout.includes('RAW_PRINT_OK')) resolve()
      else reject(new Error(stderr.trim() || stdout.trim() || `RAW_PRINT_EXIT_${exitCode}`))
    })

    ps.stdin.write(data.toString('base64'))
    ps.stdin.end()
  })
}

// ────────────────────────── Рендер HTML → 1-bit бітмап ──────────────────────────

/**
 * BGRA-кадр → 1-bit рядки TSPL BITMAP (біт 1 = білий, 0 = чорний).
 * Поріг замість дизерингу: сірий текст (#555) стає суцільно чорним,
 * фон — чисто білим, жодного «зерна». strideWidth — фактична ширина кадру,
 * width/height — скільки крапок вирізати під етикетку.
 */
function toMonochrome(bgra: Buffer, strideWidth: number, width: number, height: number): Buffer {
  const bytesPerRow = Math.ceil(width / 8)
  const bits = Buffer.alloc(bytesPerRow * height, 0xff)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * strideWidth * 4
    const outOffset = y * bytesPerRow
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * 4
      const luma = 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]
      if (luma < 160) bits[outOffset + (x >> 3)] &= ~(0x80 >> (x & 7))
    }
  }
  return bits
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const COLLECT_PAGES_SCRIPT = `
(() => {
  const pages = Array.from(document.querySelectorAll('.label-page')).map((page) => {
    const pageRect = page.getBoundingClientRect()
    const barcodes = Array.from(page.querySelectorAll('img.barcode-raster')).flatMap((img) => {
      const code = img.dataset.code || ''
      const modules = Number(img.dataset.modules) || 0
      // Без коду/кількості модулів рідний BARCODE не побудувати —
      // лишаємо картинку видимою, вона потрапить у бітмап як є.
      if (!code || modules <= 0 || /[^\\x20-\\x7e]/.test(code)) return []
      const r = img.getBoundingClientRect()
      img.style.visibility = 'hidden'
      return [{
        code, modules,
        x: r.left - pageRect.left,
        y: r.top - pageRect.top,
        w: r.width,
        h: r.height,
      }]
    })
    return { topCss: pageRect.top + window.scrollY, barcodes }
  })
  return pages
})()
`

// ────────────────────────── Основний потік друку ──────────────────────────

export async function printLabelsTspl(html: string, options: TsplPrintOptions): Promise<{ success: true; labels: number }> {
  if (typeof html !== 'string' || html.trim().length === 0) throw new Error('PRINT_HTML_EMPTY')
  const printerName = String(options.printerName ?? '').trim()
  if (!printerName) throw new Error('TSPL_PRINTER_NOT_SET')

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

  try {
    renderWindow.webContents.setFrameRate(30)
    renderWindow.webContents.startPainting()
    await renderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    renderWindow.webContents.setZoomFactor(zoom)
    // Ховаємо скролбар (інакше він звужує макет) і додаємо хвіст-прокладку,
    // щоб остання етикетка могла доскролитись рівно до верху кадру.
    await renderWindow.webContents.insertCSS(
      'html::-webkit-scrollbar{display:none} html{scrollbar-width:none}' +
      ' body::after{content:"";display:block;height:40mm}',
    )
    await renderWindow.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => null))).then(() => true)',
      true,
    )
    await waitMs(150)

    const pages = await renderWindow.webContents.executeJavaScript(COLLECT_PAGES_SCRIPT, true) as PageMeta[]
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('TSPL_NO_LABELS')

    const bytesPerRow = Math.ceil(widthDots / 8)
    const chunks: Buffer[] = []

    for (const page of pages) {
      await renderWindow.webContents.executeJavaScript(
        `window.scrollTo(0, ${JSON.stringify(page.topCss)}); true`,
        true,
      )
      await waitMs(60)

      const image = await renderWindow.webContents.capturePage()
      const size = image.getSize()
      if (size.width < widthDots || size.height < heightDots) {
        throw new Error(`TSPL_CAPTURE_SIZE ${size.width}x${size.height} < ${widthDots}x${heightDots}`)
      }
      const bitmap = toMonochrome(image.toBitmap(), size.width, widthDots, heightDots)

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

      for (const barcode of page.barcodes) {
        // Модуль штрихкоду — ЦІЛЕ число крапок (мінімум 2), інакше штрихи
        // знову стануть нерівними. Центруємо в межах місця, яке займав <img>.
        const narrow = Math.max(2, Math.floor((barcode.w * ZOOM) / barcode.modules))
        const totalWidth = narrow * barcode.modules
        const x = Math.max(0, Math.round((barcode.x + barcode.w / 2) * ZOOM - totalWidth / 2))
        const y = Math.max(0, Math.round(barcode.y * ZOOM))
        const barHeight = Math.max(8, Math.round(barcode.h * ZOOM))
        const code = barcode.code.replace(/["\\]/g, '')
        chunks.push(Buffer.from(
          `BARCODE ${x},${y},"128",${barHeight},0,0,${narrow},${narrow},"${code}"\r\n`,
          'ascii',
        ))
      }

      chunks.push(Buffer.from('PRINT 1,1\r\n', 'ascii'))
    }

    const job = Buffer.concat(chunks)
    // Діагностика без принтера: FORSAGE_TSPL_DRY_RUN=шлях — скинути потік у файл
    const dryRunPath = process.env.FORSAGE_TSPL_DRY_RUN
    if (dryRunPath) {
      fs.writeFileSync(dryRunPath, job)
      return { success: true, labels: pages.length }
    }
    await sendRawToPrinter(printerName, job)
    return { success: true, labels: pages.length }
  } finally {
    if (!renderWindow.isDestroyed()) renderWindow.destroy()
  }
}
