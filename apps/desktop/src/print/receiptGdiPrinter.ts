import { execFile, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { assertPrinterRole } from './printerRole'
import { withPrintTimeout } from './printTimeout'
import { waitForPrintProcess } from './printProcess'
import { receiptRasterLayout, renderReceiptRaster, type ReceiptPrinterProfile } from './receiptRaster'

export function canUseReceiptGdiFallback(role: string | undefined, error: unknown): boolean {
  return role === 'receipt' && error instanceof Error && error.message === 'Invalid printer settings'
}

// No RAW printer language and no default-printer fallback: Windows renders the
// receipt image through the explicitly selected receipt printer's existing driver.
export const RECEIPT_GDI_SCRIPT = String.raw`
param([string]$PrinterName, [string]$DocumentName, [switch]$InspectOnly, [int]$ExpectedWidthDots, [int]$ExpectedDpi)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$document = [Drawing.Printing.PrintDocument]::new()
$image = $null
$stream = $null
try {
  $document.PrinterSettings.PrinterName = $PrinterName
  if (-not $document.PrinterSettings.IsValid) { throw 'PRINT_RECEIPT_PRINTER_NOT_SET' }
  $page = $document.DefaultPageSettings
  $dpiX = $page.PrinterResolution.X
  $dpiY = $page.PrinterResolution.Y
  if ($dpiX -lt 100 -or $dpiX -gt 600 -or $dpiY -ne $dpiX) { throw 'PRINT_RECEIPT_INVALID_RESOLUTION' }
  $widthDots = [int][Math]::Round([Math]::Min($page.PrintableArea.Width, 58.0 / 25.4 * 100) * $dpiX / 100)
  if ($widthDots -lt 100) { throw 'PRINT_RECEIPT_INVALID_PAPER' }
  if ($InspectOnly) {
    @{widthDots=$widthDots;dpiX=$dpiX;dpiY=$dpiY} | ConvertTo-Json -Compress
    return
  }
  if ($ExpectedWidthDots -ne $widthDots -or $ExpectedDpi -ne $dpiX) { throw 'PRINT_RECEIPT_SETTINGS_CHANGED' }
  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $stream = [IO.MemoryStream]::new($bytes, 0, $bytes.Length)
  $image = [Drawing.Image]::FromStream($stream)
  if ($image.Width -ne $widthDots) { throw 'PRINT_RECEIPT_SIZE_INVALID' }
  $document.DocumentName = $DocumentName
  $document.PrintController = [Drawing.Printing.StandardPrintController]::new()
  $document.DefaultPageSettings.Margins = [Drawing.Printing.Margins]::new(0,0,0,0)
  $script:receiptOffset = 0
  $document.add_PrintPage({
    param($sender, $event)
    if ([Math]::Abs($event.Graphics.DpiX - $ExpectedDpi) -gt 0.1 -or [Math]::Abs($event.Graphics.DpiY - $ExpectedDpi) -gt 0.1) { throw 'PRINT_RECEIPT_SETTINGS_CHANGED' }
    $availableRows = [int][Math]::Floor($event.PageSettings.PrintableArea.Height * $ExpectedDpi / 100)
    $rows = [Math]::Min($image.Height - $script:receiptOffset, $availableRows)
    if ($rows -lt 1) { throw 'PRINT_RECEIPT_INVALID_PAPER' }
    $event.Graphics.PageUnit = [Drawing.GraphicsUnit]::Pixel
    $event.Graphics.PageScale = 1
    $event.Graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $event.Graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
    $event.Graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::None
    $target = [Drawing.Rectangle]::new(0, 0, $image.Width, $rows)
    $source = [Drawing.Rectangle]::new(0, $script:receiptOffset, $image.Width, $rows)
    $event.Graphics.DrawImage($image, $target, $source, [Drawing.GraphicsUnit]::Pixel)
    $script:receiptOffset += $rows
    $event.HasMorePages = $script:receiptOffset -lt $image.Height
  })
  [Console]::Out.WriteLine('FORSAGE_PRINT_STAGE:submission-started')
  $document.Print()
  [Console]::Out.WriteLine('FORSAGE_PRINT_STAGE:submitted')
  [Console]::Out.Write('RECEIPT_GDI_SUBMITTED')
} finally { $document.Dispose(); if ($image) { $image.Dispose() }; if ($stream) { $stream.Dispose() } }
`

export async function inspectReceiptPrinter(printerName: string): Promise<ReceiptPrinterProfile> {
  assertPrinterRole(printerName, 'receipt')
  const scriptPath = path.join(app.getPath('userData'), 'receipt-gdi-print.ps1')
  await writeFile(scriptPath, RECEIPT_GDI_SCRIPT, 'utf8')
  const output = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PrinterName', printerName, '-InspectOnly'], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || 'PRINT_RECEIPT_PROFILE_FAILED'))
      else resolve(stdout)
    })
  })
  let profile: ReceiptPrinterProfile
  try { profile = JSON.parse(output) } catch { throw new Error('PRINT_RECEIPT_PROFILE_FAILED') }
  receiptRasterLayout(profile)
  return profile
}

export async function printReceiptViaGdi(window: BrowserWindow, printerName: string, documentName: string): Promise<void> {
  const profile = await inspectReceiptPrinter(printerName)
  const html = await withPrintTimeout(window.webContents.executeJavaScript('document.documentElement.outerHTML'), 10_000, 'PRINT_RESOURCES_TIMEOUT') as string
  const bitmap = await renderReceiptRaster(html, profile)
  const scriptPath = path.join(app.getPath('userData'), 'receipt-gdi-print.ps1')
  const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PrinterName', printerName, '-DocumentName', documentName, '-ExpectedWidthDots', String(profile.widthDots), '-ExpectedDpi', String(profile.dpiX)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  await waitForPrintProcess(process, bitmap.toString('base64'), {
    successMarker: 'RECEIPT_GDI_SUBMITTED', failureCode: 'PRINT_RECEIPT_GDI_FAILED',
    timeoutCode: 'PRINT_OUTCOME_UNKNOWN', timeoutMs: 30_000,
    printer: printerName, documentName,
  })
}
