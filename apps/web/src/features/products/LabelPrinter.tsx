import type { Product } from "@/types/product"
import { kopecksToHryvnia } from "@/types/product"
import { PrintService } from "@/lib/printService"

/**
 * Друк етикетки 40x30мм на термопринтер.
 * Використовує iframe + JsBarcode (CDN) для рендерингу штрих-коду.
 */
export function printLabel(product: Product) {
  const shopName = "Форсаж"
  const barcodeValue = product.barcode ?? ""
  const storageBin = (product as any).storage_bin ?? ""

  const esc = PrintService.escapeHtml

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @page { margin: 0; size: 40mm 30mm; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          width: 40mm; height: 30mm;
          padding: 1.5mm 2mm;
          font-family: \x27Courier New\x27, monospace;
          font-size: 7px;
          line-height: 1.2;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }
        .shop-name { font-size: 6px; color: #666; }
        .product-name {
          font-size: 7px; font-weight: 700;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .barcode-wrap { text-align: center; margin: 1mm 0; }
        .barcode-wrap svg { max-width: 36mm; max-height: 12mm; }
        .footer {
          display: flex; justify-content: space-between; align-items: baseline;
        }
        .footer-left { font-size: 5px; color: #666; }
        .price { font-size: 12px; font-weight: 700; }
      </style>
    </head>
    <body>
      <div class="shop-name">${esc(shopName)}</div>
      <div class="product-name">${esc(product.name)}</div>
      <div class="barcode-wrap">
        <svg id="barcode-svg"></svg>
      </div>
      <div class="footer">
        <div class="footer-left">${esc(product.sku)}${storageBin ? " · " + esc(storageBin) : ""}</div>
        <div class="price">${kopecksToHryvnia(product.retail_price)} ₴</div>
      </div>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3/dist/JsBarcode.all.min.js"></script>
      <script>
        try {
          JsBarcode(\x27#barcode-svg\x27, \x27${barcodeValue}\x27, {
            width: 1.2, height: 28, fontSize: 8, margin: 0, displayValue: true,
          });
        } catch(e) {}
        window.print();
        window.close();
      </script>
    </body>
    </html>
  `

  PrintService.printHtml(html, {
    mode: "iframe",
    cleanupDelayMs: 5000
  })
}
