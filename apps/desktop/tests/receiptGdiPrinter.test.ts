import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import { canUseReceiptGdiFallback, RECEIPT_GDI_SCRIPT } from '../src/print/receiptGdiPrinter'
describe('receipt driver fallback', () => {
  it('only retries an explicitly rejected receipt, not labels or uncertain jobs', () => {
    expect(canUseReceiptGdiFallback('receipt', new Error('Invalid printer settings'))).toBe(true)
    for (const role of ['label', undefined]) expect(canUseReceiptGdiFallback(role, new Error('Invalid printer settings'))).toBe(false)
    for (const message of ['PRINT_OUTCOME_UNKNOWN', 'PRINT_NOT_CONFIRMED', 'PRINT_CANCELLED', 'PRINT_FAILED']) expect(canUseReceiptGdiFallback('receipt', new Error(message))).toBe(false)
  })
  it('keeps the selected printer and paginates without modifying other jobs', () => {
    expect(RECEIPT_GDI_SCRIPT).toContain('$document.PrinterSettings.PrinterName = $PrinterName')
    expect(RECEIPT_GDI_SCRIPT).toContain('$event.HasMorePages')
    expect(RECEIPT_GDI_SCRIPT).not.toMatch(/Remove-PrintJob|SetDefaultPrinter|RAW/)
  })
})


it('uses exact printer pixels and inspects capabilities without creating a job', () => {
  expect(RECEIPT_GDI_SCRIPT).toContain('if ($InspectOnly)')
  expect(RECEIPT_GDI_SCRIPT.indexOf('if ($InspectOnly)')).toBeLessThan(RECEIPT_GDI_SCRIPT.indexOf('[Console]::In.ReadToEnd()'))
  expect(RECEIPT_GDI_SCRIPT).toContain('$event.Graphics.PageUnit = [Drawing.GraphicsUnit]::Pixel')
  expect(RECEIPT_GDI_SCRIPT).toContain('InterpolationMode]::NearestNeighbor')
  expect(RECEIPT_GDI_SCRIPT).toContain('$image.Width -ne $widthDots')
  expect(RECEIPT_GDI_SCRIPT).not.toContain('$scale = $width / $image.Width')
})


it.skipIf(process.platform !== 'win32')('draws native black/white pixels without resampling across page boundaries', () => {
  const start = RECEIPT_GDI_SCRIPT.indexOf('  $document.add_PrintPage({') + '  $document.add_PrintPage({'.length
  const end = RECEIPT_GDI_SCRIPT.indexOf('\n  })', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const callback = RECEIPT_GDI_SCRIPT.slice(start, end)
  const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$image=[Drawing.Bitmap]::new(32,37)
$image.SetResolution(203,203)
for($y=0;$y -lt 37;$y++){for($x=0;$x -lt 32;$x++){$color=if(($x+$y)%2 -eq 0){[Drawing.Color]::Black}else{[Drawing.Color]::White};$image.SetPixel($x,$y,$color)}}
$ExpectedDpi=203
$script:receiptOffset=0
$handler={ ${callback} }
$page=0
try {
 do {
  $proof=[Drawing.Bitmap]::new(32,20);$proof.SetResolution(203,203)
  $graphics=[Drawing.Graphics]::FromImage($proof);$graphics.Clear([Drawing.Color]::White)
  $event=[pscustomobject]@{Graphics=$graphics;PageSettings=[pscustomobject]@{PrintableArea=[pscustomobject]@{Height=(20.5*100/203)}};HasMorePages=$false}
  $before=$script:receiptOffset
  try {
   & $handler $null $event
   for($y=0;$y -lt ($script:receiptOffset-$before);$y++){for($x=0;$x -lt 32;$x++){if($proof.GetPixel($x,$y).ToArgb() -ne $image.GetPixel($x,$y+$before).ToArgb()){throw 'GDI changed a pixel'}}}
   $page++
  } finally {$graphics.Dispose();$proof.Dispose()}
 } while($event.HasMorePages -and $page -lt 3)
 if($page -ne 2 -or $script:receiptOffset -ne 37 -or $event.HasMorePages){throw 'Wrong pagination'}
 'GDI_PIXEL_EXACT_2_PAGES'
} finally {$image.Dispose()}
`
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15_000})
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('GDI_PIXEL_EXACT_2_PAGES')
}, 20_000)
