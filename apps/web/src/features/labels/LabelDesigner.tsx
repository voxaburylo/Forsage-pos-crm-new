import { useState, useEffect, useCallback } from 'react'
import { Rnd } from 'react-rnd'
import { Save, Printer, Plus, Trash2, Copy, Settings, Tag, Move, FileText, Loader2 } from 'lucide-react'
import { adminApi } from '@/features/admin/adminApi'
import { productApi } from '@/features/products/productApi'
import { supplierApi } from '@/features/suppliers/supplierApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Card, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { PrintService } from '@/lib/printService'

type Tab = 'design' | 'print'

export interface LabelSettings {
  width_mm: number
  height_mm: number
  padding_mm: number
  font_size: number
  barcode_height: number
  show_shop_name: boolean
  show_product_name: boolean
  show_barcode: boolean
  show_sku: boolean
  show_price: boolean
  show_storage_bin: boolean
  // Окремі розміри шрифтів для кожного елемента
  font_size_shop: number
  font_size_title: number
  font_size_sku: number
  font_size_price: number
  // Позиції елементів (відносні, в % від розміру)
  pos_shop_name?: { x: number; y: number }
  pos_product_name?: { x: number; y: number }
  pos_barcode?: { x: number; y: number }
  pos_sku?: { x: number; y: number }
  pos_price?: { x: number; y: number }
  pos_bin?: { x: number; y: number }
  // Нові налаштування
  show_barcode_text: boolean
  barcode_width_factor: number
  max_name_lines: number
  // Вирівнювання елементів
  align_shop_name?: 'left' | 'center' | 'right'
  align_product_name?: 'left' | 'center' | 'right'
  align_price?: 'left' | 'center' | 'right'
  align_sku?: 'left' | 'center' | 'right'
  align_barcode?: 'left' | 'center' | 'right'
}

export const DEFAULT_LABEL: LabelSettings = {
  width_mm: 40, height_mm: 30, padding_mm: 2,
  font_size: 7, barcode_height: 28,
  show_shop_name: true, show_product_name: true, show_barcode: true,
  show_sku: true, show_price: true, show_storage_bin: true,
  font_size_shop: 6, font_size_title: 7, font_size_sku: 5, font_size_price: 12,
  pos_shop_name: { x: 5, y: 5 },
  pos_product_name: { x: 5, y: 25 },
  pos_barcode: { x: 10, y: 45 },
  pos_sku: { x: 5, y: 75 },
  pos_price: { x: 50, y: 75 },
  pos_bin: { x: 5, y: 88 },
  show_barcode_text: true,
  barcode_width_factor: 1.0,
  max_name_lines: 2,
  align_shop_name: 'left',
  align_product_name: 'left',
  align_price: 'left',
  align_sku: 'left',
  align_barcode: 'center',
}

type PosKey = 'pos_shop_name' | 'pos_product_name' | 'pos_barcode' | 'pos_sku' | 'pos_price' | 'pos_bin'

// ================================================================
// Малюємо фейковий штрих-код для попереднього перегляду
// ================================================================
function MockBarcode({ width, height, value, displayValue = true, fontSize = 7, previewScale = 5, align = 'center' }:
  { width: number; height: number; value: string; displayValue?: boolean; fontSize?: number; previewScale?: number; align?: string }) {
  const flexAlign = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: flexAlign, width: width + 'px' }}>
      <svg width={width} height={height} viewBox="0 0 100 35" preserveAspectRatio="none" style={{ display: 'block' }}>
        <rect x="0" y="0" width="3" height="35" fill="black" />
        <rect x="5" y="0" width="1" height="35" fill="black" />
        <rect x="8" y="0" width="2" height="35" fill="black" />
        <rect x="12" y="0" width="4" height="35" fill="black" />
        <rect x="18" y="0" width="1" height="35" fill="black" />
        <rect x="21" y="0" width="3" height="35" fill="black" />
        <rect x="26" y="0" width="2" height="35" fill="black" />
        <rect x="30" y="0" width="1" height="35" fill="black" />
        <rect x="33" y="0" width="3" height="35" fill="black" />
        <rect x="38" y="0" width="4" height="35" fill="black" />
        <rect x="44" y="0" width="1" height="35" fill="black" />
        <rect x="47" y="0" width="2" height="35" fill="black" />
        <rect x="51" y="0" width="3" height="35" fill="black" />
        <rect x="56" y="0" width="1" height="35" fill="black" />
        <rect x="59" y="0" width="4" height="35" fill="black" />
        <rect x="65" y="0" width="2" height="35" fill="black" />
        <rect x="69" y="0" width="1" height="35" fill="black" />
        <rect x="72" y="0" width="3" height="35" fill="black" />
        <rect x="77" y="0" width="2" height="35" fill="black" />
        <rect x="81" y="0" width="4" height="35" fill="black" />
        <rect x="87" y="0" width="1" height="35" fill="black" />
        <rect x="90" y="0" width="3" height="35" fill="black" />
        <rect x="95" y="0" width="2" height="35" fill="black" />
      </svg>
      {displayValue && (
        <span style={{ fontSize: fontSize * previewScale + 'px', color: '#333', fontFamily: 'monospace', marginTop: '2px', letterSpacing: '1px' }}>{value}</span>
      )}
    </div>
  )
}

export const LABEL_PRESETS: Record<string, Partial<LabelSettings> & { name: string }> = {
  standard_product_4030: {
    name: 'Товарна стандартна (40×30 мм)',
    width_mm: 40, height_mm: 30, padding_mm: 2,
    font_size_shop: 6, font_size_title: 7, font_size_sku: 5, font_size_price: 12,
    font_size: 7, barcode_height: 28,
    show_shop_name: true, show_product_name: true, show_barcode: true, show_barcode_text: true,
    show_sku: true, show_price: true, show_storage_bin: true,
    pos_shop_name: { x: 5, y: 5 },
    pos_product_name: { x: 5, y: 25 },
    pos_barcode: { x: 10, y: 45 },
    pos_sku: { x: 5, y: 75 },
    pos_price: { x: 50, y: 75 },
    pos_bin: { x: 5, y: 88 },
    barcode_width_factor: 1.0,
    max_name_lines: 2,
    align_shop_name: 'left',
    align_product_name: 'left',
    align_price: 'left',
    align_sku: 'left',
    align_barcode: 'center',
  },
  large_product_5840: {
    name: 'Товарна велика (58×40 мм)',
    width_mm: 58, height_mm: 40, padding_mm: 3,
    font_size_shop: 7, font_size_title: 9, font_size_sku: 6, font_size_price: 16,
    font_size: 8, barcode_height: 35,
    show_shop_name: true, show_product_name: true, show_barcode: true, show_barcode_text: true,
    show_sku: true, show_price: true, show_storage_bin: true,
    pos_shop_name: { x: 5, y: 5 },
    pos_product_name: { x: 5, y: 20 },
    pos_barcode: { x: 10, y: 42 },
    pos_sku: { x: 5, y: 78 },
    pos_price: { x: 50, y: 78 },
    pos_bin: { x: 5, y: 90 },
    barcode_width_factor: 1.2,
    max_name_lines: 2,
    align_shop_name: 'left',
    align_product_name: 'left',
    align_price: 'left',
    align_sku: 'left',
    align_barcode: 'center',
  },
  standard_bin_4030: {
    name: 'Ячейка стандартна (40×30 мм)',
    width_mm: 40, height_mm: 30, padding_mm: 2,
    font_size_shop: 6, font_size_title: 10, font_size_sku: 5, font_size_price: 12,
    font_size: 7, barcode_height: 28,
    show_shop_name: true, show_product_name: false, show_barcode: true, show_barcode_text: true,
    show_sku: false, show_price: false, show_storage_bin: false,
    pos_shop_name: { x: 5, y: 5 },
    pos_product_name: { x: 5, y: 25 },
    pos_barcode: { x: 10, y: 40 },
    pos_sku: { x: 5, y: 75 },
    pos_price: { x: 50, y: 75 },
    pos_bin: { x: 5, y: 25 },
    barcode_width_factor: 1.0,
    max_name_lines: 1,
    align_shop_name: 'center',
    align_product_name: 'center',
    align_price: 'center',
    align_sku: 'center',
    align_barcode: 'center',
  },
  large_bin_5840: {
    name: 'Ячейка велика (58×40 мм)',
    width_mm: 58, height_mm: 40, padding_mm: 3,
    font_size_shop: 7, font_size_title: 14, font_size_sku: 6, font_size_price: 16,
    font_size: 8, barcode_height: 35,
    show_shop_name: true, show_product_name: false, show_barcode: true, show_barcode_text: true,
    show_sku: false, show_price: false, show_storage_bin: false,
    pos_shop_name: { x: 5, y: 5 },
    pos_product_name: { x: 5, y: 20 },
    pos_barcode: { x: 10, y: 35 },
    pos_sku: { x: 5, y: 80 },
    pos_price: { x: 50, y: 80 },
    pos_bin: { x: 5, y: 20 },
    barcode_width_factor: 1.2,
    max_name_lines: 1,
    align_shop_name: 'center',
    align_product_name: 'center',
    align_price: 'center',
    align_sku: 'center',
    align_barcode: 'center',
  }
}

export const DEMO_PRODUCT: Product = {
  id: 'demo',
  name: 'Ремінь ГРМ Ланос 1.5 Gates (Тестовий товар для перевірки переносу)',
  sku: 'GT-5047',
  barcode: '4820000000012',
  retail_price: 65000,
  storage_bin: 'A-12',
  unit: 'шт',
  purchase_price: 45000,
  qty_on_hand: 10,
  reorder_point: 2,
  is_active: true,
  is_favorite: false,
  category_id: '',
  brand_id: '',
  created_at: '',
  updated_at: '',
  notes: null,
  is_service: false,
  photo_url: null,
  specs: null,
}

// ================================================================
// Preview-компонент етикетки (рендериться в реальному часі)
// ================================================================
function LabelPreview({ settings, product, binLabel, onPosChange }:
  { settings: LabelSettings; product?: Product | null; binLabel?: string; onPosChange?: (key: PosKey, pos: { x: number; y: number }) => void }) {
  const shopName = 'Форсаж'
  const previewScale = 5
  const pw = settings.width_mm * previewScale
  const ph = settings.height_mm * previewScale

  const innerW = (settings.width_mm - settings.padding_mm * 2) * previewScale
  const innerH = (settings.height_mm - settings.padding_mm * 2) * previewScale
  const padPx = settings.padding_mm * previewScale

  type RndItem = { key: PosKey; visible: boolean; children: React.ReactNode; defaultPos?: { x: number; y: number } }

  const items: RndItem[] = []

  // Спільна логіка відображення назви магазину
  if (settings.show_shop_name) {
    items.push({
      key: 'pos_shop_name',
      visible: settings.show_shop_name,
      defaultPos: settings.pos_shop_name,
      children: (
        <div style={{
          fontSize: settings.font_size_shop * previewScale + 'px',
          color: '#888',
          width: innerW * (100 - (settings.pos_shop_name?.x ?? 5)) / 100 + 'px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: settings.align_shop_name || 'left',
        }}>
          {shopName}
        </div>
      ),
    })
  }

  if (binLabel) {
    // Режим ячейки
    items.push({
      key: 'pos_bin',
      visible: true,
      defaultPos: settings.pos_bin,
      children: (
        <div style={{
          fontSize: Math.min(settings.font_size_title * previewScale, settings.width_mm * 1.5) + 'px',
          fontWeight: 700,
          textAlign: settings.align_product_name || 'center',
          width: innerW * (100 - (settings.pos_bin?.x ?? 5)) / 100 + 'px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {binLabel}
        </div>
      ),
    })

    if (settings.show_barcode) {
      items.push({
        key: 'pos_barcode',
        visible: settings.show_barcode,
        defaultPos: settings.pos_barcode,
        children: (
          <MockBarcode
            width={innerW * 0.8 * (settings.barcode_width_factor ?? 1.0)}
            height={settings.barcode_height * (previewScale / 3.78)}
            value={binLabel}
            displayValue={settings.show_barcode_text}
            fontSize={settings.font_size}
            previewScale={previewScale}
            align={settings.align_barcode || 'center'}
          />
        ),
      })
    }
  } else if (product) {
    // Режим товару
    if (settings.show_product_name) {
      items.push({
        key: 'pos_product_name',
        visible: settings.show_product_name,
        defaultPos: settings.pos_product_name,
        children: (
          <div style={{
            fontSize: settings.font_size_title * previewScale + 'px',
            fontWeight: 700,
            wordBreak: 'break-word',
            lineHeight: 1.1,
            display: '-webkit-box',
            WebkitLineClamp: settings.max_name_lines ?? 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            width: innerW * (100 - (settings.pos_product_name?.x ?? 5)) / 100 + 'px',
            textAlign: settings.align_product_name || 'left',
          }}>
            {product.name}
          </div>
        ),
      })
    }
    if (settings.show_barcode) {
      // Якщо в товару немає штрих-коду, все одно показуємо плейсхолдер у прев'ю
      const barcodeVal = product.barcode || '123456789012'
      items.push({
        key: 'pos_barcode',
        visible: settings.show_barcode,
        defaultPos: settings.pos_barcode,
        children: (
          <MockBarcode
            width={innerW * 0.8 * (settings.barcode_width_factor ?? 1.0)}
            height={settings.barcode_height * (previewScale / 3.78)}
            value={barcodeVal}
            displayValue={settings.show_barcode_text}
            fontSize={settings.font_size}
            previewScale={previewScale}
            align={settings.align_barcode || 'center'}
          />
        ),
      })
    }
    if (settings.show_sku || settings.show_storage_bin) {
      items.push({
        key: 'pos_sku',
        visible: settings.show_sku,
        defaultPos: settings.pos_sku,
        children: (
          <div style={{
            fontSize: settings.font_size_sku * previewScale + 'px',
            color: '#888',
            width: innerW * (100 - (settings.pos_sku?.x ?? 5)) / 100 + 'px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: settings.align_sku || 'left',
          }}>
            {settings.show_sku && product.sku}
            {settings.show_storage_bin && (product as any).storage_bin && <span> · {(product as any).storage_bin}</span>}
          </div>
        ),
      })
    }
    if (settings.show_price) {
      items.push({
        key: 'pos_price',
        visible: settings.show_price,
        defaultPos: settings.pos_price,
        children: (
          <div style={{
            fontSize: settings.font_size_price * previewScale + 'px',
            fontWeight: 700,
            width: innerW * (100 - (settings.pos_price?.x ?? 5)) / 100 + 'px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: settings.align_price || 'left',
          }}>
            {kopecksToHryvnia(product.retail_price)} ₴
          </div>
        ),
      })
    }
  }

  if (items.length === 0) {
    return (
      <div className="border border-gray-300 bg-white flex items-center justify-center text-gray-400"
        style={{ width: pw, height: ph, fontSize: 12 }}>
        {binLabel ? '' : 'Виберіть товар'}
      </div>
    )
  }

  return (
    <div className="border border-gray-300 bg-white relative overflow-hidden"
      style={{ width: pw, height: ph, fontFamily: "'Courier New', monospace" }}>
      
      {/* Dashed guide line representing printable boundary */}
      <div
        className="absolute border border-dashed border-gray-200 pointer-events-none"
        style={{
          left: padPx + 'px',
          top: padPx + 'px',
          width: innerW + 'px',
          height: innerH + 'px',
          zIndex: 1
        }}
      />

      <div
        className="absolute"
        style={{
          left: padPx + 'px',
          top: padPx + 'px',
          width: innerW + 'px',
          height: innerH + 'px',
        }}
      >
        {items.map((item) => {
          const pos = item.defaultPos || { x: 5, y: 5 }
          return (
            <Rnd
              key={item.key}
              position={{ x: Math.round(innerW * pos.x / 100), y: Math.round(innerH * pos.y / 100) }}
              onDragStop={(_e, d) => {
                const newX = Math.round((d.x / innerW) * 100)
                const newY = Math.round((d.y / innerH) * 100)
                onPosChange?.(item.key, { x: Math.max(0, Math.min(100, newX)), y: Math.max(0, Math.min(100, newY)) })
              }}
              bounds="parent"
              enableResizing={false}
              style={{ zIndex: 10 }}
            >
              <div className="relative group cursor-move select-none" style={{ display: 'inline-block', lineHeight: 1 }}>
                {item.children}
              </div>
            </Rnd>
          )
        })}
      </div>

      {/* Grid dots hint */}
      <div className="absolute inset-0 pointer-events-none opacity-10"
        style={{ backgroundImage: 'radial-gradient(circle, #000 0.5px, transparent 0.5px)', backgroundSize: '8px 8px' }} />
    </div>
  )
}

// ================================================================
// Друк етикеток
// ================================================================
export function printLabels(settings: LabelSettings, items: Array<Product | { label: string }>, isBins: boolean) {
  const shopName = 'Форсаж'
  const labelsHtml = items.map((item, index) => {
    const product = isBins ? null : item as Product
    const binLabel = isBins ? (item as any).label : null

    let body = ''

    if (settings.show_shop_name) {
      const pShop = settings.pos_shop_name || { x: 5, y: 5 }
      body += `<div style="position: absolute; left: ${pShop.x}%; top: ${pShop.y}%; width: ${100 - pShop.x}%; font-size: ${settings.font_size_shop}px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: ${settings.align_shop_name || 'left'};">${shopName}</div>`
    }

    if (binLabel) {
      const pBin = settings.pos_bin || { x: 5, y: 88 }
      body += `<div style="position: absolute; left: ${pBin.x}%; top: ${pBin.y}%; width: ${100 - pBin.x}%; font-size: ${settings.font_size_title + 2}px; font-weight: 700; text-align: ${settings.align_product_name || 'center'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${binLabel}</div>`
      if (settings.show_barcode) {
        const pBc = settings.pos_barcode || { x: 10, y: 45 }
        const alignBc = settings.align_barcode || 'center'
        const flexBc = alignBc === 'left' ? 'flex-start' : alignBc === 'right' ? 'flex-end' : 'center'
        body += `<div style="position: absolute; left: ${pBc.x}%; top: ${pBc.y}%; display: flex; flex-direction: column; align-items: ${flexBc};"><svg id="bin-bc-${index}"></svg></div>`
      }
    } else if (product) {
      if (settings.show_product_name) {
        const pName = settings.pos_product_name || { x: 5, y: 25 }
        body += `<div style="position: absolute; left: ${pName.x}%; top: ${pName.y}%; width: ${100 - pName.x}%; font-size: ${settings.font_size_title}px; font-weight: 700; word-break: break-word; line-height: 1.1; display: -webkit-box; -webkit-line-clamp: ${settings.max_name_lines ?? 2}; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; text-align: ${settings.align_product_name || 'left'};">${product.name}</div>`
      }
      if (settings.show_barcode && product.barcode) {
        const pBc = settings.pos_barcode || { x: 10, y: 45 }
        const alignBc = settings.align_barcode || 'center'
        const flexBc = alignBc === 'left' ? 'flex-start' : alignBc === 'right' ? 'flex-end' : 'center'
        body += `<div style="position: absolute; left: ${pBc.x}%; top: ${pBc.y}%; display: flex; flex-direction: column; align-items: ${flexBc};"><svg id="bc-${product.id}-${index}"></svg></div>`
      }
      if (settings.show_sku || (settings.show_storage_bin && (product as any).storage_bin)) {
        const pSku = settings.pos_sku || { x: 5, y: 75 }
        let skuText = ''
        if (settings.show_sku) skuText += product.sku
        if (settings.show_storage_bin && (product as any).storage_bin) skuText += ` · ${(product as any).storage_bin}`
        body += `<div style="position: absolute; left: ${pSku.x}%; top: ${pSku.y}%; width: ${100 - pSku.x}%; font-size: ${settings.font_size_sku}px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: ${settings.align_sku || 'left'};">${skuText}</div>`
      }
      if (settings.show_price) {
        const pPrice = settings.pos_price || { x: 50, y: 75 }
        body += `<div style="position: absolute; left: ${pPrice.x}%; top: ${pPrice.y}%; width: ${100 - pPrice.x}%; font-size: ${settings.font_size_price}px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: ${settings.align_price || 'left'};">${kopecksToHryvnia(product.retail_price)} ₴</div>`
      }
    }

    return `
      <div class="label">
        ${body}
      </div>
    `
  }).join('')

  const w = settings.width_mm
  const h = settings.height_mm

  const html = `<!DOCTYPE html>
<html><head><style>
  @page { margin: 0; size: ${w}mm ${h}mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${w}mm; min-height: ${h}mm;
    padding: ${settings.padding_mm}mm;
    font-family: 'Courier New', monospace;
    font-size: ${settings.font_size}px;
    line-height: 1.2;
    overflow: hidden;
  }
  .label {
    width: ${w - settings.padding_mm * 2}mm;
    height: ${h - settings.padding_mm * 2}mm;
    position: relative;
    page-break-inside: avoid;
    page-break-after: always;
  }
  .label svg { max-width: ${w - settings.padding_mm * 2}mm; max-height: ${settings.barcode_height * 1.2}px; }
</style></head><body>
  ${labelsHtml}
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3/dist/JsBarcode.all.min.js"></script>
  <script>
    try { ${items.map((i, idx) => {
      if (isBins) {
        const bin = (i as any).label
        if (!bin || !settings.show_barcode) return ''
        return `JsBarcode('#bin-bc-${idx}', '${bin}', { width: ${(settings.barcode_width_factor ?? 1.0) * 1.2}, height: ${settings.barcode_height}, fontSize: ${settings.font_size + 1}, margin: 0, displayValue: ${settings.show_barcode_text ?? true} });`
      }
      const p = i as Product
      if (!p.barcode) return ''
      return `JsBarcode('#bc-${p.id}-${idx}', '${p.barcode}', { width: ${(settings.barcode_width_factor ?? 1.0) * 1.2}, height: ${settings.barcode_height}, fontSize: ${settings.font_size + 1}, margin: 0, displayValue: ${settings.show_barcode_text ?? true} });`
    }).filter(Boolean).join('\n')} } catch(e) {}
    window.onload = function() { setTimeout(function() { window.print(); window.close(); }, 500); };
  </script>
</body></html>`

  PrintService.printHtml(html, { mode: 'iframe', cleanupDelayMs: 30000 })
}

// ================================================================
// Головна сторінка
// ================================================================
export default function LabelDesigner() {
  const [tab, setTab] = useState<Tab>('design')
  const [settings, setSettings] = useState<LabelSettings>(DEFAULT_LABEL)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  // Стан для вкладки "Друк"
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [printItems, setPrintItems] = useState<Array<Product & { copies: number }>>([])
  const [binMode, setBinMode] = useState(false)
  const [binInput, setBinInput] = useState('')
  const [binLabels, setBinLabels] = useState<string[]>([])

  // Стан для масового створення ячейок
  const [binPrefix, setBinPrefix] = useState('A-')
  const [binStart, setBinStart] = useState<number | ''>(1)
  const [binEnd, setBinEnd] = useState<number | ''>(10)

  function handleGenerateBinSeries() {
    const startVal = typeof binStart === 'number' ? binStart : 0;
    const endVal = typeof binEnd === 'number' ? binEnd : 0;
    if (startVal > endVal) {
      toast.error('Початковий номер має бути меншим за кінцевий')
      return
    }
    const count = endVal - startVal + 1
    if (count > 200) {
      toast.error('За один раз можна згенерувати не більше 200 ячейок')
      return
    }
    const newBins: string[] = []
    for (let i = startVal; i <= endVal; i++) {
      newBins.push(`${binPrefix}${i}`)
    }
    setBinLabels((prev) => [...prev, ...newBins])
    toast.success(`Згенеровано та додано ${count} ячейок`)
  }


  // Categories/Brands для группового додавання
  const [categories, setCategories] = useState<any[]>([])
  const [brands, setBrands] = useState<any[]>([])
  const [selectedCatId, setSelectedCatId] = useState('')
  const [selectedBrandId, setSelectedBrandId] = useState('')
  const [groupCopies, setGroupCopies] = useState<number | ''>(1)
  const [groupLoading, setGroupLoading] = useState(false)

  // Накладні для імпорту
  const [isInvoiceModalOpen, setIsInvoiceModalOpen] = useState(false)
  const [invoices, setInvoices] = useState<any[]>([])
  const [invoicesLoading, setInvoicesLoading] = useState(false)

  // Стратегія кількості етикеток при імпорті з накладної
  const [invoiceCopiesStrategy, setInvoiceCopiesStrategy] = useState<'invoice_qty' | 'fixed'>('invoice_qty')
  const [invoiceFixedCopies, setInvoiceFixedCopies] = useState<number | ''>(1)

  // Фільтр для списку друку та автогенерація штрих-кодів
  const [printQueueFilter, setPrintQueueFilter] = useState('')
  const [generatingBarcodes, setGeneratingBarcodes] = useState(false)

  async function handleGenerateMissingBarcodes() {
    const missing = printItems.filter(p => !p.barcode)
    if (missing.length === 0) {
      toast.success('Усі товари вже мають штрих-коди')
      return
    }
    setGeneratingBarcodes(true)
    try {
      let updatedCount = 0
      const updatedItems = [...printItems]
      
      for (const item of missing) {
        try {
          const res = await productApi.generateBarcode(item.id)
          const updatedProd = res.data
          
          const idx = updatedItems.findIndex(p => p.id === item.id)
          if (idx !== -1) {
            updatedItems[idx] = { ...updatedItems[idx], barcode: updatedProd.barcode }
          }
          updatedCount++
        } catch (err) {
          console.error(`Помилка генерації для ${item.name}:`, err)
        }
      }
      
      setPrintItems(updatedItems)
      toast.success(`Згенеровано штрих-коди для ${updatedCount} товарів`)
    } catch {
      toast.error('Помилка генерації штрих-кодів')
    } finally {
      setGeneratingBarcodes(false)
    }
  }



  // Завантажуємо налаштування, категорії та бренди
  useEffect(() => {
    adminApi.getSettings()
      .then((res) => {
        if (res.data.label_settings) {
          setSettings({ ...DEFAULT_LABEL, ...res.data.label_settings })
        }
      })
      .catch(() => toast.error('Помилка завантаження налаштувань'))
      .finally(() => setLoading(false))

    adminApi.listCategories().then((res) => setCategories(res.data)).catch(() => {})
    adminApi.listBrands().then((res) => setBrands(res.data)).catch(() => {})
  }, [])

  // Пошук товарів
  useEffect(() => {
    if (!searchQuery.trim() || binMode) { setSearchResults([]); return }
    const timer = setTimeout(async () => {
      try {
        const { data } = await productApi.search(searchQuery, 10)
        setSearchResults(data)
      } catch { setSearchResults([]) }
    }, 250)
    return () => clearTimeout(timer)
  }, [searchQuery, binMode])

  const updateSetting = useCallback(<K extends keyof LabelSettings>(key: K, value: LabelSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handlePosChange = useCallback((key: PosKey, pos: { x: number; y: number }) => {
    setSettings((prev) => ({ ...prev, [key]: pos }))
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const sanitized = {
        ...settings,
        width_mm: settings.width_mm || 40,
        height_mm: settings.height_mm || 30,
        padding_mm: settings.padding_mm || 0,
        font_size_shop: settings.font_size_shop || 6,
        font_size_title: settings.font_size_title || 7,
        font_size_sku: settings.font_size_sku || 5,
        font_size_price: settings.font_size_price || 12,
        max_name_lines: settings.max_name_lines || 2,
        barcode_width_factor: settings.barcode_width_factor || 1.0,
        font_size: settings.font_size || 7,
        barcode_height: settings.barcode_height || 28,
      }
      await adminApi.updateSettings({ label_settings: sanitized as any })
      setSettings(sanitized)
      toast.success('Налаштування етикеток збережено')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  function addToPrint(product: Product) {
    if (printItems.some((p) => p.id === product.id)) {
      setPrintItems((prev) => prev.map((p) => p.id === product.id ? { ...p, copies: p.copies + 1 } : p))
    } else {
      setPrintItems((prev) => [...prev, { ...product, copies: 1 }])
    }
    setSearchQuery('')
    setSearchResults([])
  }

  // Відкриття модалки накладних та завантаження списку
  async function openInvoiceModal() {
    setIsInvoiceModalOpen(true)
    setInvoicesLoading(true)
    try {
      const res = await supplierApi.listInvoices({ per_page: 50 })
      setInvoices(res.data || [])
    } catch {
      toast.error('Помилка завантаження накладних')
    } finally {
      setInvoicesLoading(false)
    }
  }

  // Завантаження товарів з обраної накладної
  async function loadInvoiceItems(invoiceId: string) {
    setInvoicesLoading(true)
    try {
      const { data } = await supplierApi.getInvoice(invoiceId)
      const items = data.items || []
      const validItems = items.filter((i) => i.product)
      if (validItems.length === 0) {
        toast.error('У цій накладній немає товарів')
        setInvoicesLoading(false)
        return
      }

      const fullProducts = await Promise.all(
        validItems.map(async (item) => {
          const qty = invoiceCopiesStrategy === 'invoice_qty' ? item.qty : (typeof invoiceFixedCopies === 'number' ? invoiceFixedCopies : 1)
          try {
            const res = await productApi.get(item.product!.id)
            return { ...res.data, copies: qty }
          } catch {
            return { ...item.product!, copies: qty }
          }
        })
      )

      setPrintItems((prev) => {
        const merged = [...prev]
        fullProducts.forEach((prod) => {
          const existing = merged.find((p) => p.id === prod.id)
          if (existing) {
            existing.copies += typeof prod.copies === 'number' ? prod.copies : 1
          } else {
            merged.push({ ...prod, copies: typeof prod.copies === 'number' ? prod.copies : 1 } as any)
          }
        })
        return merged
      })

      toast.success(`Додано ${validItems.length} товарів з накладної`)
      setIsInvoiceModalOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження накладної')
    } finally {
      setInvoicesLoading(false)
    }
  }

  // Додавання товарів групою (за категорією/брендом)
  async function handleAddGroup() {
    if (!selectedCatId && !selectedBrandId) {
      toast.error('Виберіть категорію або бренд')
      return
    }
    setGroupLoading(true)
    try {
      const { data } = await productApi.list({
        category_id: selectedCatId || undefined,
        brand_id: selectedBrandId || undefined,
        per_page: 500,
      })

      if (!data || data.length === 0) {
        toast.error('Товарів не знайдено за вибраними фільтрами')
        return
      }

      setPrintItems((prev) => {
        const merged = [...prev]
        const numGroupCopies = typeof groupCopies === 'number' ? groupCopies : 1
        data.forEach((prod) => {
          const existing = merged.find((p) => p.id === prod.id)
          if (existing) {
            existing.copies += numGroupCopies
          } else {
            merged.push({ ...prod, copies: numGroupCopies })
          }
        })
        return merged
      })

      toast.success(`Додано ${data.length} товарів`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження товарів')
    } finally {
      setGroupLoading(false)
    }
  }

  function handlePrint() {
    if (binMode) {
      const items = binLabels.map((label) => ({ label }))
      if (items.length === 0) { toast.error('Додайте хоча б одну ячейку'); return }
      printLabels(settings, items, true)
    } else {
      const items = printItems.flatMap((p) => Array(p.copies).fill(p))
      if (items.length === 0) { toast.error('Додайте товари для друку'); return }
      printLabels(settings, items, false)
    }
  }

  if (loading) return (
    <Layout title="Друк етикеток">
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
    </Layout>
  )

  return (
    <Layout title="Друк етикеток">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex gap-2">
          <button onClick={() => setTab('design')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'design' ? 'bg-accent text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            <Settings size={16} /> Дизайнер
          </button>
          <button onClick={() => setTab('print')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'print' ? 'bg-accent text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            <Printer size={16} /> Друк
          </button>
        </div>

        <div className="flex gap-2 bg-gray-100 p-1 rounded-lg">
          <button onClick={() => setBinMode(false)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              !binMode ? 'bg-white text-black shadow-sm' : 'bg-transparent text-gray-600 hover:text-gray-900'
            }`}>
            <Tag size={14} className="inline mr-1" />Товари
          </button>
          <button onClick={() => setBinMode(true)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              binMode ? 'bg-white text-black shadow-sm' : 'bg-transparent text-gray-600 hover:text-gray-900'
            }`}>
            <Copy size={14} className="inline mr-1" />Ячейки (Bins)
          </button>
        </div>
      </div>

      {tab === 'design' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Налаштування */}
          <div className="space-y-4">
            <Card className="space-y-4">
              <div className="flex justify-between items-center border-b border-gray-100 pb-2">
                <h3 className="text-sm font-semibold text-gray-800">Розміри</h3>
                <div>
                  <select
                    onChange={(e) => {
                      const key = e.target.value
                      if (key && LABEL_PRESETS[key]) {
                        setSettings((prev) => ({ ...prev, ...LABEL_PRESETS[key] }))
                        toast.success('Завантажено шаблон: ' + LABEL_PRESETS[key].name)
                      }
                    }}
                    defaultValue=""
                    className="border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="" disabled>Завантажити шаблон...</option>
                    {Object.entries(LABEL_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Ширина (мм)" type="number" min={20} max={120} step={0.1} value={settings.width_mm === 0 ? '' : settings.width_mm}
                  onChange={(e) => updateSetting('width_mm', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
                <Input label="Висота (мм)" type="number" min={15} max={100} step={0.1} value={settings.height_mm === 0 ? '' : settings.height_mm}
                  onChange={(e) => updateSetting('height_mm', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
              </div>
              <Input label="Відступ (мм)" type="number" min={0} max={10} step={0.1} value={settings.padding_mm === 0 ? '' : settings.padding_mm}
                onChange={(e) => {
                  const val = parseFloat(e.target.value)
                  updateSetting('padding_mm', (isNaN(val) ? 0 : val) as any)
                }} />
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Шрифти та штрих-код</h3>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Назва магазину" type="number" min={4} max={20} step={0.1} value={settings.font_size_shop === 0 ? '' : settings.font_size_shop}
                  onChange={(e) => updateSetting('font_size_shop', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
                <Input label="Назва товару" type="number" min={4} max={20} step={0.1} value={settings.font_size_title === 0 ? '' : settings.font_size_title}
                  onChange={(e) => updateSetting('font_size_title', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Артикул / SKU" type="number" min={4} max={20} step={0.1} value={settings.font_size_sku === 0 ? '' : settings.font_size_sku}
                  onChange={(e) => updateSetting('font_size_sku', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
                <Input label="Ціна" type="number" min={4} max={30} step={0.1} value={settings.font_size_price === 0 ? '' : settings.font_size_price}
                  onChange={(e) => updateSetting('font_size_price', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Рядків назви (макс)" type="number" min={1} max={5} value={settings.max_name_lines === 0 ? '' : settings.max_name_lines}
                  onChange={(e) => updateSetting('max_name_lines', (e.target.value === '' ? 0 : (parseInt(e.target.value) || 0)) as any)} />
                <Input label="Ширина штрих-коду" type="number" min={0.5} max={2.5} step={0.1} value={settings.barcode_width_factor === 0 ? '' : settings.barcode_width_factor}
                  onChange={(e) => updateSetting('barcode_width_factor', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
              </div>
              <Input label="Розмір цифр штрих-коду (px)" type="number" min={4} max={20} step={0.1} value={settings.font_size === 0 ? '' : settings.font_size}
                onChange={(e) => updateSetting('font_size', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
              <Input label="Висота штрих-коду (px)" type="number" min={10} max={60} step={0.5} value={settings.barcode_height === 0 ? '' : settings.barcode_height}
                onChange={(e) => updateSetting('barcode_height', (e.target.value === '' ? 0 : (parseFloat(e.target.value) || 0)) as any)} />
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Вирівнювання тексту</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Назва магазину</label>
                  <select
                    value={settings.align_shop_name || 'left'}
                    onChange={(e) => updateSetting('align_shop_name', e.target.value as any)}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="left">Ліворуч</option>
                    <option value="center">По центру</option>
                    <option value="right">Праворуч</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Назва товару</label>
                  <select
                    value={settings.align_product_name || 'left'}
                    onChange={(e) => updateSetting('align_product_name', e.target.value as any)}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="left">Ліворуч</option>
                    <option value="center">По центру</option>
                    <option value="right">Праворуч</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Артикул / SKU</label>
                  <select
                    value={settings.align_sku || 'left'}
                    onChange={(e) => updateSetting('align_sku', e.target.value as any)}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="left">Ліворуч</option>
                    <option value="center">По центру</option>
                    <option value="right">Праворуч</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Ціна</label>
                  <select
                    value={settings.align_price || 'left'}
                    onChange={(e) => updateSetting('align_price', e.target.value as any)}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="left">Ліворуч</option>
                    <option value="center">По центру</option>
                    <option value="right">Праворуч</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Штрих-код</label>
                  <select
                    value={settings.align_barcode || 'center'}
                    onChange={(e) => updateSetting('align_barcode', e.target.value as any)}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="left">Ліворуч</option>
                    <option value="center">По центру</option>
                    <option value="right">Праворуч</option>
                  </select>
                </div>
              </div>
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Елементи етикетки</h3>
              {[
                { key: 'show_shop_name', label: 'Назва магазину' },
                { key: 'show_product_name', label: 'Назва товару' },
                { key: 'show_barcode', label: 'Штрих-код' },
                { key: 'show_barcode_text', label: 'Текст під штрих-кодом' },
                { key: 'show_sku', label: 'Артикул' },
                { key: 'show_price', label: 'Ціна' },
                { key: 'show_storage_bin', label: 'Місце зберігання' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between py-1">
                  <span className="text-sm text-gray-700">{label}</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox"
                      checked={(settings as any)[key] ?? true}
                      onChange={(e) => updateSetting(key as keyof LabelSettings, e.target.checked as any)}
                      className="sr-only peer" />
                    <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-yellow-400 after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                  </label>
                </div>
              ))}
            </Card>

            <Button onClick={handleSave} loading={saving} icon={<Save size={16} />}>
              Зберегти налаштування
            </Button>
          </div>

          {/* Preview */}
          <div className="sticky top-6">
            <Card>
              <h3 className="text-sm font-semibold text-gray-800 mb-4">Попередній перегляд</h3>
              <div className="flex items-center justify-center bg-gray-100 rounded-xl p-4 min-h-[200px] overflow-x-auto max-w-full">
                {binMode ? (
                  <LabelPreview settings={settings} binLabel={binLabels[binLabels.length - 1] || 'A-1'} onPosChange={handlePosChange} />
                ) : (
                  <LabelPreview settings={settings} product={printItems[0] || DEMO_PRODUCT} onPosChange={handlePosChange} />
                )}
              </div>
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-gray-400">
                  [{settings.width_mm}×{settings.height_mm}mm]
                  {binMode ? (
                    ` · Ячейка: ${binLabels[binLabels.length - 1] || 'A-1'}`
                  ) : (
                    printItems.length > 0 ? ` · ${printItems[0].name}` : ` · ${DEMO_PRODUCT.name}`
                  )}
                </p>
                <p className="text-xs text-gray-400">
                  <Move size={10} className="inline" /> Тягніть елементи мишкою
                </p>
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === 'print' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Пошук та додавання */}
          <div className="space-y-4">
            {!binMode ? (
              <>
                {/* Джерело додавання */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
                      Поштучне додавання
                    </label>
                    <Input value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)} placeholder="Назва товару, артикул..." />
                    {searchResults.length > 0 && (
                      <div className="mt-2 max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y bg-white">
                        {searchResults.map((p) => (
                          <button key={p.id} onClick={() => addToPrint(p)}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 flex items-center justify-between transition-colors">
                            <span className="font-medium">{p.name}</span>
                            <span className="text-xs text-gray-400">{p.sku} · {kopecksToHryvnia(p.retail_price)} ₴</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-gray-200 pt-4 flex gap-3">
                    <Button variant="outline" size="sm" onClick={openInvoiceModal} className="flex-1">
                      <FileText size={14} className="mr-1.5" /> Завантажити з накладної
                    </Button>
                  </div>
                </div>

                {/* Групове додавання за категорією/брендом */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-3">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Групове додавання товарів
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Категорія</label>
                      <select value={selectedCatId} onChange={(e) => setSelectedCatId(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white">
                        <option value="">Усі категорії</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Бренд</label>
                      <select value={selectedBrandId} onChange={(e) => setSelectedBrandId(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white">
                        <option value="">Усі бренди</option>
                        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-3 items-end pt-1">
                    <div className="w-24">
                      <label className="block text-[10px] text-gray-400 mb-1">Кількість копій</label>
                      <input type="number" min={1} value={groupCopies === 0 ? '' : groupCopies} onChange={(e) => setGroupCopies(e.target.value === '' ? 0 : Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white h-[30px]" />
                    </div>
                    <Button size="sm" onClick={handleAddGroup} loading={groupLoading} className="flex-1">
                      <Plus size={14} className="mr-1.5" /> Додати групу
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                {/* Поштучне додавання */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-2">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Поштучне додавання ячейки
                  </label>
                  <div className="flex gap-2">
                    <Input value={binInput} onChange={(e) => setBinInput(e.target.value.toUpperCase())}
                      placeholder="Назва ячейки: A-3, B12, Стелаж 5..."
                      className="flex-1" />
                    <Button size="sm" onClick={() => { if (binInput.trim()) { setBinLabels((prev) => [...prev, binInput.trim()]); setBinInput('') } }}>
                      <Plus size={14} />
                    </Button>
                  </div>
                </div>

                {/* Масове генерування серії ячейок */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-3">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Масове генерування ячейок
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Префікс</label>
                      <input type="text" value={binPrefix} onChange={(e) => setBinPrefix(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white h-[30px]" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Початок (№)</label>
                      <input type="number" min={1} value={binStart === 0 ? '' : binStart} onChange={(e) => setBinStart(e.target.value === '' ? 0 : Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white h-[30px]" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Кінець (№)</label>
                      <input type="number" min={1} value={binEnd === 0 ? '' : binEnd} onChange={(e) => setBinEnd(e.target.value === '' ? 0 : Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white h-[30px]" />
                    </div>
                  </div>
                  <Button size="sm" onClick={handleGenerateBinSeries} className="w-full">
                    Згенерувати серію ячейок
                  </Button>
                </div>
              </div>
            )}

            {/* Список для друку */}
            <Card padding="none">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">
                  {binMode ? 'Ячейки' : 'Товари'} ({binMode ? binLabels.length : printItems.reduce((s, i) => s + i.copies, 0)} шт)
                </span>
                <div className="flex gap-2">
                  {!binMode && printItems.some(p => !p.barcode) && (
                    <Button size="sm" variant="outline" onClick={handleGenerateMissingBarcodes} loading={generatingBarcodes} className="text-xs">
                      Згенерувати штрих-коди
                    </Button>
                  )}
                  {!binMode && printItems.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setPrintItems([])}>Очистити</Button>
                  )}
                  {binMode && binLabels.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setBinLabels([])}>Очистити</Button>
                  )}
                </div>
              </div>

              {!binMode && printItems.length > 0 && (
                <div className="px-4 py-2 border-b border-gray-100 bg-gray-50/50">
                  <input
                    type="text"
                    placeholder="Пошук у списку друку..."
                    value={printQueueFilter}
                    onChange={(e) => setPrintQueueFilter(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white"
                  />
                </div>
              )}

              {!binMode ? (
                <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                  {printItems.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-8">Додайте товари через пошук або накладну</p>
                  ) : (
                    (() => {
                      const filtered = printItems.filter(item => {
                        if (!printQueueFilter.trim()) return true
                        const q = printQueueFilter.toLowerCase()
                        return (
                          item.name.toLowerCase().includes(q) ||
                          item.sku.toLowerCase().includes(q) ||
                          (item.barcode && item.barcode.includes(q))
                        )
                      })
                      if (filtered.length === 0) {
                        return <p className="text-gray-400 text-sm text-center py-8">Товарів не знайдено</p>
                      }
                      return filtered.map((item) => (
                        <div key={item.id} className="px-4 py-2 flex items-center justify-between text-sm">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{item.name}</p>
                            <p className="text-xs text-gray-400">
                              {item.sku}{!item.barcode && <span className="text-red-400 ml-2">(немає штрих-коду)</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 ml-2">
                            <button onClick={() => setPrintItems((prev) => prev.map((p) => p.id === item.id ? { ...p, copies: Math.max(1, p.copies - 1) } : p))}
                              className="w-6 h-6 bg-gray-100 rounded text-gray-600 hover:bg-gray-200">−</button>
                            <input
                              type="number"
                              min={1}
                              value={item.copies === 0 || isNaN(item.copies) ? '' : item.copies}
                              onChange={(e) => {
                                const val = e.target.value === '' ? 0 : Math.max(1, parseInt(e.target.value) || 1)
                                setPrintItems((prev) => prev.map((p) => p.id === item.id ? { ...p, copies: val } : p))
                              }}
                              className="w-12 text-center font-medium border border-gray-200 rounded py-0.5 focus:outline-none focus:ring-1 focus:ring-accent bg-white h-[24px]"
                            />
                            <button onClick={() => setPrintItems((prev) => prev.map((p) => p.id === item.id ? { ...p, copies: p.copies + 1 } : p))}
                              className="w-6 h-6 bg-gray-100 rounded text-gray-600 hover:bg-gray-200">+</button>
                            <button onClick={() => setPrintItems((prev) => prev.filter((p) => p.id !== item.id))}
                              className="ml-1 text-red-300 hover:text-red-500"><Trash2 size={14} /></button>
                          </div>
                        </div>
                      ))
                    })()
                  )}
                </div>
              ) : (
                <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                  {binLabels.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-8">Додайте назви ячейок</p>
                  ) : (
                    binLabels.map((label, i) => (
                      <div key={i} className="px-4 py-2 flex items-center justify-between text-sm">
                        <span className="font-mono font-medium">{label}</span>
                        <button onClick={() => setBinLabels((prev) => prev.filter((_, idx) => idx !== i))}
                          className="text-red-300 hover:text-red-500"><Trash2 size={14} /></button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* Preview та друк */}
          <div className="space-y-4">
            <Card>
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Попередній перегляд</h3>
              <div className="flex items-center justify-center bg-gray-100 rounded-xl p-4 min-h-[150px] overflow-x-auto max-w-full">
                {binMode ? (
                  <LabelPreview settings={settings} binLabel={binLabels[binLabels.length - 1] || 'A-1'} />
                ) : (
                  <LabelPreview settings={settings} product={printItems[0] || DEMO_PRODUCT} />
                )}
              </div>
            </Card>

            <Button onClick={handlePrint} className="w-full" icon={<Printer size={16} />}>
              Друк ({binMode ? binLabels.length : printItems.reduce((s, i) => s + i.copies, 0)} шт)
            </Button>
          </div>
        </div>
      )}

      {/* Модалка вибору накладної */}
      <Modal open={isInvoiceModalOpen} onClose={() => setIsInvoiceModalOpen(false)} title="Виберіть приходну накладну" size="lg">
        <div className="space-y-4">
          {invoicesLoading ? (
            <div className="text-center py-8 text-sm text-gray-400 flex justify-center items-center gap-2">
              <Loader2 className="animate-spin" size={16} /> Завантаження накладних...
            </div>
          ) : invoices.length === 0 ? (
            <div className="text-center py-8 text-sm text-gray-400">Накладних не знайдено</div>
          ) : (
            <>
              {/* Опції кількості */}
              <div className="bg-gray-50 p-3 rounded-xl border border-gray-100 flex flex-wrap gap-4 items-center justify-between">
                <span className="text-xs font-semibold text-gray-700">Кількість етикеток для кожного товару при імпорті:</span>
                <div className="flex gap-4 items-center">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input type="radio" checked={invoiceCopiesStrategy === 'invoice_qty'} onChange={() => setInvoiceCopiesStrategy('invoice_qty')} className="text-accent" />
                    Кількість з накладної
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input type="radio" checked={invoiceCopiesStrategy === 'fixed'} onChange={() => setInvoiceCopiesStrategy('fixed')} className="text-accent" />
                    Фіксована кількість:
                  </label>
                  {invoiceCopiesStrategy === 'fixed' && (
                    <input type="number" min={1} value={invoiceFixedCopies === 0 ? '' : invoiceFixedCopies} onChange={(e) => setInvoiceFixedCopies(e.target.value === '' ? 0 : Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-14 border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white h-[26px]" />
                  )}
                </div>
              </div>

              <div className="max-h-96 overflow-y-auto border border-gray-200 rounded-xl divide-y">
                {invoices.map((inv) => (
                  <div key={inv.id} className="p-3 flex justify-between items-center hover:bg-gray-50 transition-colors">
                    <div>
                      <p className="font-semibold text-sm text-gray-900">Накладна №{inv.invoice_number || '—'}</p>
                      <p className="text-xs text-gray-400">
                        Постачальник: {inv.supplier?.name || '—'} · Дата: {new Date(inv.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-gray-700">{kopecksToHryvnia(inv.total)} ₴</span>
                      <Button size="sm" onClick={() => loadInvoiceItems(inv.id)}>Вибрати</Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end pt-2 border-t border-gray-100">
            <Button variant="secondary" onClick={() => setIsInvoiceModalOpen(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
