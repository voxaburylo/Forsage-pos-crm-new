import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { assertPrinterRole } from './printerRole'
import { withPrintTimeout } from './printTimeout'

export function canUseReceiptGdiFallback(role: string | undefined, error: unknown): boolean {
  return role === 'receipt' && error instanceof Error && error.message === 'Invalid printer settings'
}

// No RAW printer language and no default-printer fallback: Windows renders the
// receipt image through the explicitly selected receipt printer's existing driver.
export const RECEIPT_GDI_SCRIPT = String.raw`
param([string]$PrinterName, [string]$DocumentName)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$stream = [IO.MemoryStream]::new($bytes, 0, $bytes.Length)
$image = [Drawing.Image]::FromStream($stream)
$document = [Drawing.Printing.PrintDocument]::new()
try {
  $document.PrinterSettings.PrinterName = $PrinterName
  if (-not $document.PrinterSettings.IsValid) { throw 'PRINT_RECEIPT_PRINTER_NOT_SET' }
  $document.DocumentName = $DocumentName
  $document.PrintController = [Drawing.Printing.StandardPrintController]::new()
  $document.DefaultPageSettings.Margins = [Drawing.Printing.Margins]::new(0,0,0,0)
  $script:receiptOffset = 0
  $document.add_PrintPage({
    param($sender, $event)
    $area = $event.PageSettings.PrintableArea
    $width = [Math]::Min($area.Width, 58.0 / 25.4 * 100)
    if ($width -le 0 -or $area.Height -le 0) { throw 'PRINT_RECEIPT_INVALID_PAPER' }
    $scale = $width / $image.Width
    $rows = [Math]::Min($image.Height - $script:receiptOffset, [Math]::Floor($area.Height / $scale))
    if ($rows -lt 1) { throw 'PRINT_RECEIPT_INVALID_PAPER' }
    $target = [Drawing.RectangleF]::new(0, 0, $width, $rows * $scale)
    $source = [Drawing.RectangleF]::new(0, $script:receiptOffset, $image.Width, $rows)
    $event.Graphics.DrawImage($image, $target, $source, [Drawing.GraphicsUnit]::Pixel)
    $script:receiptOffset += $rows
    $event.HasMorePages = $script:receiptOffset -lt $image.Height
  })
  $document.Print()
  [Console]::Out.Write('RECEIPT_GDI_SUBMITTED')
} finally { $document.Dispose(); $image.Dispose(); $stream.Dispose() }
`

export async function printReceiptViaGdi(window: BrowserWindow, printerName: string, documentName: string): Promise<void> {
  assertPrinterRole(printerName, 'receipt')
  // Capture at twice CSS resolution, including a long receipt, not just the viewport.
  window.webContents.setZoomFactor(2)
  window.setContentSize(640, 600)
  const stopRender = () => { if (!window.isDestroyed()) window.destroy() }
  const bounds = await withPrintTimeout(window.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.receipt-print') || document.body;
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.x * 2), y: Math.floor(r.y * 2), width: Math.ceil(r.width * 2), height: Math.ceil(el.scrollHeight * 2) };
  })()`), 10_000, 'PRINT_RESOURCES_TIMEOUT', stopRender)
  if (!bounds || bounds.width < 1 || bounds.width > 1200 || bounds.height < 1 || bounds.height > 16000) throw new Error('PRINT_RECEIPT_SIZE_INVALID')
  window.setContentSize(Math.max(640, bounds.x + bounds.width), Math.max(600, bounds.y + bounds.height))
  await withPrintTimeout(window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))'), 10_000, 'PRINT_RESOURCES_TIMEOUT', stopRender)
  const bitmap = await withPrintTimeout(window.webContents.capturePage(bounds), 10_000, 'PRINT_RENDER_TIMEOUT', stopRender)
  const scriptPath = path.join(app.getPath('userData'), 'receipt-gdi-print.ps1')
  await writeFile(scriptPath, RECEIPT_GDI_SCRIPT, 'utf8')
  await new Promise<void>((resolve, reject) => {
    const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PrinterName', printerName, '-DocumentName', documentName], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = '', settled = false
    const finish = (failure?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure) reject(failure); else resolve()
    }
    const timer = setTimeout(() => { process.kill(); finish(new Error('PRINT_OUTCOME_UNKNOWN')) }, 30_000)
    process.stdout.on('data', data => { output += String(data).slice(0, 4096) })
    process.stderr.on('data', data => { error += String(data).slice(0, 4096) })
    process.on('error', finish)
    process.stdin.on('error', finish)
    process.on('close', code => finish(code === 0 && output.includes('RECEIPT_GDI_SUBMITTED') ? undefined : new Error(error || 'PRINT_RECEIPT_GDI_FAILED')))
    process.stdin.end(bitmap.toPNG().toString('base64'))
  })
}
