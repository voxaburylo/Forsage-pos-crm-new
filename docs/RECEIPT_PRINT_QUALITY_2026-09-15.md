# POS58 receipt quality — 2026-09-15

## Evidence
- Owner confirmed both printers physically print, then reported small/poor-quality receipts and supplied six copies of a receipt photograph. It shows broken-looking glyph edges, a long receipt number squeezed into several lines next to the date, and the footer close to the tear line.
- Read-only System.Drawing query of POS-58-Series reports a 203x203 dpi head and PrintableArea.Width 189.16257 hundredths of an inch: 384 dots, approximately 48.05 mm. The driver paper name says 58x297, but its effective width is approximately 48 mm.
- Previous GDI fallback captured a 58/80 mm screenshot at zoom 2 and scaled its entire width into that area. For 58 mm this reduced all text to about 83% and resampled antialiased greys. This explains software-side shrinking; it does not exclude thermal paper/head/heat contribution to the physical print.

## Changes
- GDI helper inspect-only mode reads selected receipt printer capabilities without sending a job. It checks stable width/dpi again before printing; no driver settings, USB ports or printer roles changed.
- Added dedicated offscreen receipt rasterizer that reflows to actual printer width, fixes offscreen DPR=1, renders at dpi/96 zoom, thresholds to black/white and sends exact printer pixels. It does not resize the screenshot.
- Native checks found Electron capturePage resamples offscreen output at display scaling. Use the native offscreen paint frame instead, accepting only the blank safety border's one-pixel DIP rounding. Native renders at display scales 100%, 125% and 200% were byte-identical: width 384, zero grey pixels (before the last spacing-only CSS adjustment).
- GDI DrawImage uses pixel units, nearest-neighbour sampling and identical source/destination dimensions. Page splitting preserves rows. A Windows-only test runs the actual PrintPage callback on synthetic checkerboard bitmaps, verifies every pixel and two-page continuity WITHOUT invoking a printer or PrintDocument.Print.
- Receipt: Arial instead of Courier; main/name text 15px, supporting text 12px; price calculation 13px with a nonbreaking quantity/unit group. Number and date each have their own line. Bottom padding increased to 6 mm for a tear margin. Labels unchanged.
- Printer failure explanations include unreadable profile, changed settings, unexpected scale and oversized/cropped frames. No automatic retry or cross-printer fallback added.

## Verification and pending delivery
- 444 desktop tests passed before adding the separate native GDI alignment test; that additional test and the other three receipt-driver tests subsequently passed. All 511 web tests passed, desktop/web typechecks passed.
- Native render-only fixtures and logs are under tmp/receipt-quality*, tmp/receipt-render*. They use synthetic receipt data, isolated temporary Electron userData, and do not modify the working database or send print jobs.
- tmp/receipt-quality-print-test.cjs is prepared for exactly one technical receipt; NOT run yet. Await owner permission for new paper test.
- The active application remains open; receipt quality changes are NOT yet in the installed EXE. Existing 17:20 EXE includes earlier print transport fixes but not this quality work. Must rebuild same EXE after owner closes application. No push performed.

## Delivered build, 19:39 local
- Owner closed the application; verified no running Forsage process before replacing the existing EXE in place. Build completed with exit 0 at 2026-09-15 19:39:48 +03. No additional desktop copies/folders.
- apps/desktop/release/Forsage-0.1.0-portable.exe: 91,322,041 bytes; SHA256 06C77BCB4F51CE69E818053F528FA68FD84F45A59139D19D75BAEC182501B0F8. Existing ФОРСАЖ — КАСА shortcut targets this exact file.
- Verified receiptRaster, printer capability/pixel-drawing code and rp-item-price renderer style inside app.asar.
- Final full desktop suite: 445/445 tests passed (78 files). Isolated native Electron DB smoke passed; all data was in a temporary test database. Full web suite previously passed 511 tests and both typechecks passed.
- No new physical test receipt was printed during this rebuild; owner only confirmed application closure. Physical quality confirmation is still pending. No labels, printer ports, live database data, Git remote or Vercel deployment changed in this delivery.
