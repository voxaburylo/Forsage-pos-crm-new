import { useState, useEffect, useCallback, useRef } from 'react'
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
import { renderBarcodeSvg } from '@/lib/barcodeSvg'
import { desktopBridge } from '@/lib/desktopBridge'
import { usePOSBarcodeScanner } from '@/features/pos/usePOSBarcodeScanner'
import { loadTsplSettings, saveTsplSettings, pickLabelPrinter, type TsplLabelPrintSettings } from './tsplPrintSettings'

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
  // Калібрування конкретного принтера (не змінює дизайн етикетки)
  offset_x_mm?: number
  offset_y_mm?: number
  // Вирівнювання елементів
  align_shop_name?: 'left' | 'center' | 'right'
  align_product_name?: 'left' | 'center' | 'right'
  align_price?: 'left' | 'center' | 'right'
  align_sku?: 'left' | 'center' | 'right'
  align_barcode?: 'left' | 'center' | 'right'
  bin_settings?: LabelSettings
}

export const DEFAULT_BIN_LABEL: LabelSettings = {
  width_mm: 40, height_mm: 30, padding_mm: 1.5,
  font_size: 6, barcode_height: 22,
  show_shop_name: true, show_product_name: false, show_barcode: true,
  show_sku: false, show_price: false, show_storage_bin: false,
  font_size_shop: 5, font_size_title: 12, font_size_sku: 5, font_size_price: 10,
  pos_shop_name: { x: 0, y: 0 },
  pos_product_name: { x: 0, y: 12 },
  pos_barcode: { x: 5, y: 45 },
  pos_sku: { x: 5, y: 75 },
  pos_price: { x: 50, y: 75 },
  pos_bin: { x: 0, y: 12 },
  show_barcode_text: true,
  barcode_width_factor: 1.0,
  max_name_lines: 1,
  offset_x_mm: 0,
  offset_y_mm: 0,
  align_shop_name: 'center',
  align_product_name: 'center',
  align_price: 'center',
  align_sku: 'center',
  align_barcode: 'center',
}

export const DEFAULT_LABEL: LabelSettings = {
  width_mm: 40, height_mm: 30, padding_mm: 1.5,
  font_size: 6, barcode_height: 20,
  show_shop_name: true, show_product_name: true, show_barcode: true,
  show_sku: true, show_price: true, show_storage_bin: true,
  font_size_shop: 5, font_size_title: 6.5, font_size_sku: 5, font_size_price: 10,
  pos_shop_name: { x: 0, y: 0 },
  pos_product_name: { x: 0, y: 10 },
  pos_barcode: { x: 5, y: 36 },
  pos_sku: { x: 0, y: 68 },
  pos_price: { x: 55, y: 78 },
  pos_bin: { x: 0, y: 82 },
  show_barcode_text: true,
  barcode_width_factor: 1.0,
  max_name_lines: 2,
  offset_x_mm: 0,
  offset_y_mm: 0,
  align_shop_name: 'left',
  align_product_name: 'left',
  align_price: 'left',
  align_sku: 'left',
  align_barcode: 'center',
}

// Фізичний рулон користувача. Швидкий друк із картки товару завжди використовує
// цей компактний макет, незалежно від старого збереженого шаблону 40×30.
export const QUICK_PRODUCT_LABEL_4025: LabelSettings = {
  ...DEFAULT_LABEL,
  width_mm: 40,
  height_mm: 25,
  padding_mm: 1,
  font_size_shop: 4.5,
  font_size_title: 6,
  font_size_sku: 4.5,
  font_size_price: 9,
  font_size: 5.5,
  barcode_height: 18,
  pos_shop_name: { x: 0, y: 0 },
  pos_product_name: { x: 0, y: 11 },
  pos_barcode: { x: 4, y: 38 },
  pos_sku: { x: 0, y: 72 },
  pos_price: { x: 55, y: 78 },
  pos_bin: { x: 0, y: 86 },
}

type PosKey = 'pos_shop_name' | 'pos_product_name' | 'pos_barcode' | 'pos_sku' | 'pos_price' | 'pos_bin'

// ─── Числове поле з вільним редагуванням, дробами (крок 0.5), комою/крапкою та ± ───
function NumberField({ label, value, min, max, step = 0.5, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  // Синхронізуємо текст із зовнішнім значенням (пресети, ±, перезавантаження) — лише поза фокусом
  useEffect(() => { if (!focused.current) setText(String(value)) }, [value])

  const norm = (n: number) => Math.round(Math.max(min, Math.min(max, n)) * 100) / 100

  function commit(raw: string) {
    const n = parseFloat(raw.replace(',', '.'))
    if (isNaN(n)) { setText(String(value)); return }  // порожнє/некоректне — повертаємо попереднє
    const c = norm(n)
    onChange(c); setText(String(c))
  }
  function bump(delta: number) {
    const base = parseFloat(text.replace(',', '.'))
    const cur = isNaN(base) ? value : base
    const next = norm(cur + delta)
    onChange(next); setText(String(next))
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-stretch">
        <button type="button" onClick={() => bump(-step)}
          className="w-8 shrink-0 border border-gray-200 rounded-l-lg bg-gray-50 hover:bg-gray-100 text-gray-600 font-bold text-lg leading-none"
          aria-label="Зменшити">−</button>
        <input
          type="text" inputMode="decimal" value={text}
          onFocus={() => { focused.current = true }}
          onChange={(e) => {
            const val = e.target.value;
            setText(val);
            const n = parseFloat(val.replace(',', '.'));
            if (!isNaN(n)) {
              onChange(norm(n));
            }
          }}
          onBlur={(e) => { focused.current = false; commit(e.target.value) }}
          className="w-full min-w-0 border-y border-gray-200 px-2 py-2 text-sm text-center focus:outline-none focus:ring-1 focus:ring-accent" />
        <button type="button" onClick={() => bump(step)}
          className="w-8 shrink-0 border border-gray-200 rounded-r-lg bg-gray-50 hover:bg-gray-100 text-gray-600 font-bold text-lg leading-none"
          aria-label="Збільшити">+</button>
      </div>
    </div>
  )
}

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
        <span style={{ fontSize: fontSize * previewScale * 25.4 / 72 + 'px', color: '#333', fontFamily: 'monospace', marginTop: '2px', letterSpacing: '1px' }}>{value}</span>
      )}
    </div>
  )
}

export const LABEL_PRESETS: Record<string, Partial<LabelSettings> & { name: string }> = {
  compact_product_4025: {
    ...QUICK_PRODUCT_LABEL_4025,
    name: 'Товарна компактна (40×25 мм)',
  },
  standard_product_4030: {
    name: 'Товарна стандартна (40×30 мм)',
    width_mm: 40, height_mm: 30, padding_mm: 1.5,
    font_size_shop: 5, font_size_title: 6.5, font_size_sku: 5, font_size_price: 10,
    font_size: 6, barcode_height: 20,
    show_shop_name: true, show_product_name: true, show_barcode: true, show_barcode_text: true,
    show_sku: true, show_price: true, show_storage_bin: true,
    pos_shop_name: { x: 0, y: 0 },
    pos_product_name: { x: 0, y: 10 },
    pos_barcode: { x: 5, y: 36 },
    pos_sku: { x: 0, y: 68 },
    pos_price: { x: 55, y: 78 },
    pos_bin: { x: 0, y: 82 },
    barcode_width_factor: 1.0,
    max_name_lines: 2,
    offset_x_mm: 0,
    offset_y_mm: 0,
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
    offset_x_mm: 0,
    offset_y_mm: 0,
    align_shop_name: 'left',
    align_product_name: 'left',
    align_price: 'left',
    align_sku: 'left',
    align_barcode: 'center',
  },
  standard_bin_4030: {
    name: 'Комірка стандартна (40×30 мм)',
    width_mm: 40, height_mm: 30, padding_mm: 1.5,
    font_size_shop: 5, font_size_title: 12, font_size_sku: 5, font_size_price: 10,
    font_size: 6, barcode_height: 22,
    show_shop_name: true, show_product_name: false, show_barcode: true, show_barcode_text: true,
    show_sku: false, show_price: false, show_storage_bin: false,
    pos_shop_name: { x: 0, y: 0 },
    pos_product_name: { x: 0, y: 12 },
    pos_barcode: { x: 5, y: 45 },
    pos_sku: { x: 5, y: 75 },
    pos_price: { x: 50, y: 75 },
    pos_bin: { x: 0, y: 12 },
    barcode_width_factor: 1.0,
    max_name_lines: 1,
    offset_x_mm: 0,
    offset_y_mm: 0,
    align_shop_name: 'center',
    align_product_name: 'center',
    align_price: 'center',
    align_sku: 'center',
    align_barcode: 'center',
  },
  large_bin_5840: {
    name: 'Комірка велика (58×40 мм)',
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
    offset_x_mm: 0,
    offset_y_mm: 0,
    align_shop_name: 'center',
    align_product_name: 'center',
    align_price: 'center',
    align_sku: 'center',
    align_barcode: 'center',
  }
}

export const PRODUCT_LABEL_PRESET_OPTIONS = [
  { value: 'compact_product_4025', label: '40×25 мм — поточний рулон' },
  { value: 'standard_product_4030', label: '40×30 мм' },
  { value: 'large_product_5840', label: '58×40 мм' },
  { value: 'saved', label: 'Мій розмір із дизайнера' },
] as const

export type ProductLabelPresetKey = typeof PRODUCT_LABEL_PRESET_OPTIONS[number]['value']
export const PRODUCT_LABEL_PRESET_STORAGE_KEY = 'forsage_product_label_preset'

export function resolveProductLabelSettings(
  savedSettings: Partial<LabelSettings> | null | undefined,
  presetKey: ProductLabelPresetKey,
): LabelSettings {
  const saved = { ...DEFAULT_LABEL, ...(savedSettings ?? {}) }
  if (presetKey === 'saved') return saved

  const preset = LABEL_PRESETS[presetKey] ?? LABEL_PRESETS.compact_product_4025
  const { name: _name, ...presetSettings } = preset
  return {
    ...saved,
    ...presetSettings,
    // Калібрування належить принтеру, тому зберігаємо його при зміні рулону.
    offset_x_mm: saved.offset_x_mm ?? 0,
    offset_y_mm: saved.offset_y_mm ?? 0,
  } as LabelSettings
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
          fontSize: settings.font_size_shop * previewScale * 25.4 / 72 + 'px',
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
          fontSize: Math.min(settings.font_size_title * previewScale * 25.4 / 72, settings.width_mm * 1.5) + 'px',
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
            fontSize: settings.font_size_title * previewScale * 25.4 / 72 + 'px',
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
            fontSize: settings.font_size_sku * previewScale * 25.4 / 72 + 'px',
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
            fontSize: settings.font_size_price * previewScale * 25.4 / 72 + 'px',
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
export interface LabelPrintDocument {
  html: string
  title: string
  widthMm: number
  heightMm: number
  count: number
}

export function buildLabelPrintDocument(settings: LabelSettings, items: Array<Product | { label: string }>, isBins: boolean): LabelPrintDocument {
  const shopName = 'Форсаж'
  const esc = PrintService.escapeHtml
  const w = Math.max(20, Math.min(120, Number(settings.width_mm) || 40))
  const h = Math.max(15, Math.min(100, Number(settings.height_mm) || 30))
  const padding = Math.max(0, Math.min(Math.min(w, h) / 3, Number(settings.padding_mm) || 0))
  const offsetX = Math.max(-10, Math.min(10, Number(settings.offset_x_mm) || 0))
  const offsetY = Math.max(-10, Math.min(10, Number(settings.offset_y_mm) || 0))
  const barcodeHeight = Math.max(10, Math.min(80, Number(settings.barcode_height) || 28))
  const barcodeWidth = Math.max(0.5, Math.min(2.5, Number(settings.barcode_width_factor) || 1))

  const labelsHtml = items.map((item) => {
    const product = isBins ? null : item as Product
    const binLabel = isBins ? String((item as { label: string }).label || '') : null

    let body = ''

    if (settings.show_shop_name) {
      const pShop = settings.pos_shop_name || { x: 5, y: 5 }
      body += `<div style="position:absolute;left:${pShop.x}%;top:${pShop.y}%;width:${100 - pShop.x}%;font-size:${settings.font_size_shop}pt;line-height:1;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:${settings.align_shop_name || 'left'};">${esc(shopName)}</div>`
    }

    if (binLabel) {
      const pBin = settings.pos_bin || { x: 5, y: 88 }
      body += `<div style="position:absolute;left:${pBin.x}%;top:${pBin.y}%;width:${100 - pBin.x}%;font-size:${Math.min(settings.font_size_title, 30)}pt;font-weight:700;line-height:1;text-align:${settings.align_product_name || 'center'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(binLabel)}</div>`
      if (settings.show_barcode) {
        const pBc = settings.pos_barcode || { x: 10, y: 45 }
        const alignBc = settings.align_barcode || 'center'
        const flexBc = alignBc === 'left' ? 'flex-start' : alignBc === 'right' ? 'flex-end' : 'center'
        const horizontalBc = alignBc === 'center'
          ? 'left:0;right:0;'
          : alignBc === 'right'
            ? `left:0;right:${Math.max(0, pBc.x)}%;`
            : `left:${pBc.x}%;right:0;`
        const barcode = renderBarcodeSvg(binLabel, { width: barcodeWidth * 1.2, height: barcodeHeight })
        if (!barcode.includes('barcode-raster')) throw new Error(`Не вдалося створити штрихкод ${binLabel}`)
        body += `<div class="barcode" style="position:absolute;${horizontalBc}top:${pBc.y}%;display:flex;align-items:${flexBc};overflow:visible;"><div class="barcode-inner">${barcode}${(settings.show_barcode_text ?? true) ? `<span>${esc(binLabel)}</span>` : ''}</div></div>`
      }
    } else if (product) {
      if (settings.show_product_name) {
        const pName = settings.pos_product_name || { x: 5, y: 25 }
        body += `<div style="position:absolute;left:${pName.x}%;top:${pName.y}%;width:${100 - pName.x}%;font-size:${settings.font_size_title}pt;font-weight:700;overflow-wrap:anywhere;line-height:1.1;display:-webkit-box;-webkit-line-clamp:${settings.max_name_lines ?? 2};-webkit-box-orient:vertical;overflow:hidden;text-align:${settings.align_product_name || 'left'};">${esc(product.name)}</div>`
      }
      if (settings.show_barcode && product.barcode) {
        const pBc = settings.pos_barcode || { x: 10, y: 45 }
        const alignBc = settings.align_barcode || 'center'
        const flexBc = alignBc === 'left' ? 'flex-start' : alignBc === 'right' ? 'flex-end' : 'center'
        const horizontalBc = alignBc === 'center'
          ? 'left:0;right:0;'
          : alignBc === 'right'
            ? `left:0;right:${Math.max(0, pBc.x)}%;`
            : `left:${pBc.x}%;right:0;`
        const barcode = renderBarcodeSvg(product.barcode, { width: barcodeWidth * 1.2, height: barcodeHeight })
        if (!barcode.includes('barcode-raster')) throw new Error(`Не вдалося створити штрихкод ${product.barcode}`)
        body += `<div class="barcode" style="position:absolute;${horizontalBc}top:${pBc.y}%;display:flex;align-items:${flexBc};overflow:visible;"><div class="barcode-inner">${barcode}${(settings.show_barcode_text ?? true) ? `<span>${esc(product.barcode)}</span>` : ''}</div></div>`
      }
      if (settings.show_sku || (settings.show_storage_bin && (product as any).storage_bin)) {
        const pSku = settings.pos_sku || { x: 5, y: 75 }
        let skuText = ''
        if (settings.show_sku) skuText += product.sku
        if (settings.show_storage_bin && (product as any).storage_bin) skuText += ` · ${(product as any).storage_bin}`
        body += `<div style="position:absolute;left:${pSku.x}%;top:${pSku.y}%;width:${100 - pSku.x}%;font-size:${settings.font_size_sku}pt;line-height:1;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:${settings.align_sku || 'left'};">${esc(skuText)}</div>`
      }
      if (settings.show_price) {
        const pPrice = settings.pos_price || { x: 50, y: 75 }
        body += `<div style="position:absolute;left:${pPrice.x}%;top:${pPrice.y}%;width:${100 - pPrice.x}%;font-size:${settings.font_size_price}pt;line-height:.9;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:${settings.align_price || 'left'};">${esc(kopecksToHryvnia(product.retail_price))} ₴</div>`
      }
    }

    return `
      <section class="label-page">
        <div class="label-content">${body}</div>
      </section>
    `
  }).join('')

  if (!labelsHtml) {
    throw new Error('Немає етикеток для друку.')
  }

  const html = `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><title>Етикетки ${w}×${h} мм</title><style>
  @page { margin: 0; size: ${w}mm ${h}mm; }
  html, body { margin: 0 !important; padding: 0 !important; width: ${w}mm; min-width: ${w}mm; background: #fff; }
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #000; }
  .label-page {
    position: relative;
    width: ${w}mm;
    height: ${h}mm;
    margin: 0;
    padding: ${padding}mm;
    overflow: hidden;
    break-inside: avoid;
    break-after: page;
    page-break-inside: avoid;
    page-break-after: always;
  }
  .label-page:last-child { break-after: auto; page-break-after: auto; }
  .label-content {
    position: relative;
    width: ${Math.max(1, w - padding * 2)}mm;
    height: ${Math.max(1, h - padding * 2)}mm;
    transform: translate(${offsetX}mm, ${offsetY}mm);
    transform-origin: top left;
    overflow: hidden;
  }
  .barcode-inner {
    display: inline-flex;
    flex: 0 1 auto;
    flex-direction: column;
    align-items: center;
    width: fit-content;
    max-width: calc(100% - 2mm);
  }
  .barcode-inner span {
    display: block;
    width: 100%;
    margin-top: .3mm;
    color: #222;
    font-family: monospace;
    font-size: ${settings.font_size}pt;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
  }
  .barcode svg,
  .barcode img {
    display: block;
    width: auto;
    max-width: 100%;
    height: ${barcodeHeight}px;
    flex: 0 1 auto;
    overflow: visible;
    shape-rendering: crispEdges;
    image-rendering: pixelated;
  }
  @media print {
    html, body { width: ${w}mm !important; min-width: ${w}mm !important; }
    .label-page { width: ${w}mm !important; height: ${h}mm !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style></head><body>
  ${labelsHtml}
</body></html>`

  return {
    html,
    title: `Етикетки ${w}×${h} мм`,
    widthMm: w,
    heightMm: h,
    count: items.length,
  }
}

function printLabelDocumentViaDriver(document: LabelPrintDocument) {
  PrintService.printHtml(document.html, {
    mode: 'iframe',
    title: document.title,
    pageSizeMm: { width: document.widthMm, height: document.heightMm },
    preferDesktopNative: true,
    showDesktopPreview: false,
    // Предпросмотр показываем прямо в интерфейсе программы. В Electron/Windows
    // системный print preview часто недоступен, поэтому в драйвер отправляем
    // только саму печать, без отдельного окна предпросмотра.
    useDriverPaper: true,
    cleanupDelayMs: 30000,
    readyDelayMs: 50,
  })
}

/**
 * Принтер етикеток для TSPL: збережений у налаштуваннях, або знаходимо
 * автоматично за назвою (HL80/HiLabel/…) і запам'ятовуємо — щоб працювало
 * «з коробки» без жодних налаштувань.
 */
export async function resolveTsplPrinter(): Promise<string | null> {
  const desktop = desktopBridge()
  const tspl = loadTsplSettings()
  if (!desktop?.print?.labelsTspl || !tspl.enabled) return null
  if (tspl.printerName) return tspl.printerName
  try {
    const printers = await desktop.print.listPrinters()
    const found = pickLabelPrinter(printers)
    if (found) saveTsplSettings({ ...tspl, printerName: found })
    return found
  } catch {
    return null
  }
}

export function printLabelDocument(document: LabelPrintDocument) {
  // Прямий TSPL-друк (desktop): рендер точно під 203 dpi термоголовку і RAW
  // у спулер повз растеризацію драйвера — без артефактів і «мила». Якщо
  // принтера етикеток нема або сталася помилка — тихо йдемо через драйвер.
  const desktop = desktopBridge()
  if (desktop?.print?.labelsTspl) {
    const tspl = loadTsplSettings()
    resolveTsplPrinter().then((printerName) => {
      if (!printerName) {
        printLabelDocumentViaDriver(document)
        return
      }
      desktop.print.labelsTspl(document.html, {
        printerName,
        widthMm: document.widthMm,
        heightMm: document.heightMm,
        gapMm: tspl.gapMm,
        density: tspl.density,
        rotate180: tspl.rotate180,
      }).then(({ labels }) => {
        import('@/components/ui/Toast').then(({ toast }) =>
          toast.success(`Надруковано ${labels} етикеток`))
      }).catch((error: unknown) => {
        console.error('TSPL label print failed, falling back to driver', error)
        import('@/components/ui/Toast').then(({ toast }) =>
          toast.error('Прямий друк не вдався ('
            + (error instanceof Error ? error.message : 'помилка')
            + ') — друкую через драйвер'))
        printLabelDocumentViaDriver(document)
      })
    })
    return
  }
  printLabelDocumentViaDriver(document)
}

export function printLabels(settings: LabelSettings, items: Array<Product | { label: string }>, isBins: boolean) {
  printLabelDocument(buildLabelPrintDocument(settings, items, isBins))
}

// ================================================================
// Головна сторінка
// ================================================================
export default function LabelDesigner() {
  // Друк — головний сценарій сторінки, дизайн налаштовують зрідка
  const [tab, setTab] = useState<Tab>('print')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  // Стан для вкладки "Друк"
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [printItems, setPrintItems] = useState<Array<Product & { copies: number }>>([])
  const [binMode, setBinMode] = useState(false)
  const [binInput, setBinInput] = useState('')
  const [binLabels, setBinLabels] = useState<string[]>([])
  const [printPreviewDoc, setPrintPreviewDoc] = useState<LabelPrintDocument | null>(null)
  const [productSettings, setProductSettings] = useState<LabelSettings>(DEFAULT_LABEL)
  const [binSettings, setBinSettings] = useState<LabelSettings>(DEFAULT_BIN_LABEL)
  const settings = binMode ? binSettings : productSettings

  // Прямий TSPL-друк (лише desktop-каса)
  const desktopPrint = desktopBridge()?.print
  const tsplAvailable = typeof desktopPrint?.labelsTspl === 'function'
  const [tsplSettings, setTsplSettings] = useState<TsplLabelPrintSettings>(loadTsplSettings)
  const [systemPrinters, setSystemPrinters] = useState<Array<{ name: string; displayName: string; isDefault: boolean }>>([])
  const [tsplTesting, setTsplTesting] = useState(false)

  useEffect(() => {
    if (!tsplAvailable || typeof desktopPrint?.listPrinters !== 'function') return
    desktopPrint.listPrinters().then(setSystemPrinters).catch(() => setSystemPrinters([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tsplAvailable])

  function updateTspl(patch: Partial<TsplLabelPrintSettings>) {
    setTsplSettings((prev) => {
      const next = { ...prev, ...patch }
      saveTsplSettings(next)
      return next
    })
  }

  async function handleTsplTest() {
    if (!desktopPrint?.labelsTspl) return
    setTsplTesting(true)
    try {
      const printerName = tsplSettings.printerName || await resolveTsplPrinter()
      if (!printerName) {
        toast.error('Принтер етикеток не знайдено — оберіть його у списку')
        return
      }
      const doc = buildLabelPrintDocument(settings, binMode ? [{ label: 'A-1' }] : [DEMO_PRODUCT], binMode)
      await desktopPrint.labelsTspl(doc.html, {
        printerName,
        widthMm: doc.widthMm,
        heightMm: doc.heightMm,
        gapMm: tsplSettings.gapMm,
        density: tsplSettings.density,
        rotate180: tsplSettings.rotate180,
      })
      toast.success('Тестова етикетка відправлена на принтер')
    } catch (error) {
      toast.error('Тест не вдався: ' + (error instanceof Error ? error.message : 'помилка'))
    } finally {
      setTsplTesting(false)
    }
  }

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
      toast.error('За один раз можна згенерувати не більше 200 комірок')
      return
    }
    const newBins: string[] = []
    for (let i = startVal; i <= endVal; i++) {
      newBins.push(`${binPrefix}${i}`)
    }
    setBinLabels((prev) => [...prev, ...newBins])
    toast.success(`Згенеровано та додано ${count} комірок`)
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

  // Сканер штрих-кодів на вкладці друку
  const [scanning, setScanning] = useState(false)
  const scanSeq = useRef(0)

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
          const loaded = res.data.label_settings
          setProductSettings({ ...DEFAULT_LABEL, ...loaded })
          if (loaded.bin_settings) {
            setBinSettings({ ...DEFAULT_BIN_LABEL, ...loaded.bin_settings })
          } else {
            setBinSettings(DEFAULT_BIN_LABEL)
          }
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
    if (binMode) {
      setBinSettings((prev) => ({ ...prev, [key]: value }))
    } else {
      setProductSettings((prev) => ({ ...prev, [key]: value }))
    }
  }, [binMode])

  const handlePosChange = useCallback((key: PosKey, pos: { x: number; y: number }) => {
    if (binMode) {
      setBinSettings((prev) => ({ ...prev, [key]: pos }))
    } else {
      setProductSettings((prev) => ({ ...prev, [key]: pos }))
    }
  }, [binMode])

  async function handleSave() {
    setSaving(true)
    try {
      const sanitizedProduct = {
        ...productSettings,
        width_mm: Math.max(20, Math.min(120, productSettings.width_mm || 40)),
        height_mm: Math.max(15, Math.min(100, productSettings.height_mm || 30)),
        padding_mm: Math.max(0, Math.min(10, productSettings.padding_mm || 0)),
        font_size_shop: Math.max(4, Math.min(20, productSettings.font_size_shop || 6)),
        font_size_title: Math.max(4, Math.min(20, productSettings.font_size_title || 7)),
        font_size_sku: Math.max(4, Math.min(20, productSettings.font_size_sku || 5)),
        font_size_price: Math.max(4, Math.min(30, productSettings.font_size_price || 12)),
        max_name_lines: Math.max(1, Math.min(5, productSettings.max_name_lines || 2)),
        barcode_width_factor: Math.max(0.5, Math.min(2.5, productSettings.barcode_width_factor || 1.0)),
        font_size: Math.max(4, Math.min(20, productSettings.font_size || 7)),
        barcode_height: Math.max(10, Math.min(60, productSettings.barcode_height || 28)),
        offset_x_mm: Math.max(-10, Math.min(10, productSettings.offset_x_mm || 0)),
        offset_y_mm: Math.max(-10, Math.min(10, productSettings.offset_y_mm || 0)),
      }
      const sanitizedBin = {
        ...binSettings,
        width_mm: Math.max(20, Math.min(120, binSettings.width_mm || 40)),
        height_mm: Math.max(15, Math.min(100, binSettings.height_mm || 30)),
        padding_mm: Math.max(0, Math.min(10, binSettings.padding_mm || 0)),
        font_size_shop: Math.max(4, Math.min(20, binSettings.font_size_shop || 6)),
        font_size_title: Math.max(4, Math.min(20, binSettings.font_size_title || 7)),
        font_size_sku: Math.max(4, Math.min(20, binSettings.font_size_sku || 5)),
        font_size_price: Math.max(4, Math.min(30, binSettings.font_size_price || 12)),
        max_name_lines: Math.max(1, Math.min(5, binSettings.max_name_lines || 2)),
        barcode_width_factor: Math.max(0.5, Math.min(2.5, binSettings.barcode_width_factor || 1.0)),
        font_size: Math.max(4, Math.min(20, binSettings.font_size || 7)),
        barcode_height: Math.max(10, Math.min(60, binSettings.barcode_height || 28)),
        offset_x_mm: Math.max(-10, Math.min(10, binSettings.offset_x_mm || 0)),
        offset_y_mm: Math.max(-10, Math.min(10, binSettings.offset_y_mm || 0)),
      }
      const payload = {
        ...sanitizedProduct,
        bin_settings: sanitizedBin
      }
      await adminApi.updateSettings({ label_settings: payload as any }, { silent: true })
      setProductSettings(sanitizedProduct)
      setBinSettings(sanitizedBin)
      toast.success('Налаштування етикеток збережено')
    } catch {
      toast.error('Не вдалося зберегти налаштування. Спробуйте ще раз.')
    } finally {
      setSaving(false)
    }
  }

  function addToPrint(product: Product) {
    // Функціонально від prev: сканер додає товар після await, коли замикання
    // з printItems уже застаріле — інакше швидкі скани поспіль губились.
    setPrintItems((prev) => prev.some((p) => p.id === product.id)
      ? prev.map((p) => p.id === product.id ? { ...p, copies: p.copies + 1 } : p)
      : [...prev, { ...product, copies: 1 }])
    setSearchQuery('')
    setSearchResults([])
  }

  /**
   * Скан HID-сканера: точний збіг за штрих-кодом/артикулом одразу летить
   * у чергу друку, неоднозначний — у список під пошуком, щоб обрати вручну.
   */
  async function handleScan(code: string) {
    if (binMode) return
    setTab('print')
    const seq = ++scanSeq.current
    setScanning(true)
    try {
      const { data } = await productApi.search(code, 10)
      if (seq !== scanSeq.current) return
      const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
      const wanted = norm(code)
      const exact = data.find((p) => norm(p.barcode) === wanted || norm(p.sku) === wanted)
        ?? (data.length === 1 ? data[0] : undefined)

      if (exact) {
        addToPrint(exact)
        toast.success(`+1 етикетка: ${exact.name}`)
      } else if (data.length > 0) {
        setSearchQuery(code)
        setSearchResults(data)
        toast.error(`Знайдено ${data.length} товарів за «${code}» — оберіть потрібний`)
      } else {
        setSearchQuery(code)
        setSearchResults([])
        toast.error(`Товар зі штрих-кодом ${code} не знайдено`)
      }
    } catch {
      if (seq === scanSeq.current) toast.error('Помилка пошуку за штрих-кодом')
    } finally {
      if (seq === scanSeq.current) setScanning(false)
    }
  }

  usePOSBarcodeScanner({ onScan: handleScan })

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

  function buildCurrentPrintDocument(): LabelPrintDocument | null {
    if (binMode) {
      const items = binLabels.map((label) => ({ label }))
      if (items.length === 0) { toast.error('Додайте хоча б одну комірку'); return null }
      return buildLabelPrintDocument(settings, items, true)
    }
    const items = printItems.flatMap((p) => Array(p.copies).fill(p))
    if (items.length === 0) { toast.error('Додайте товари для друку'); return null }
    if (settings.show_barcode) {
      const missingBarcodeCount = printItems.filter((p) => !p.barcode).length
      if (missingBarcodeCount > 0) {
        toast.error(`У ${missingBarcodeCount} товар(ів) немає штрихкоду. Спочатку натисніть «Згенерувати штрих-коди».`)
        return null
      }
    }
    return buildLabelPrintDocument(settings, items, false)
  }

  function handlePrint() {
    try {
      const document = buildCurrentPrintDocument()
      if (document) setPrintPreviewDoc(document)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося підготувати друк')
    }
  }

  function handleConfirmPrint() {
    if (!printPreviewDoc) return
    try {
      printLabelDocument(printPreviewDoc)
      setPrintPreviewDoc(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося відкрити друк')
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
          <button onClick={() => setTab('print')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'print' ? 'bg-accent text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            <Printer size={16} /> Друк
          </button>
          <button onClick={() => setTab('design')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'design' ? 'bg-accent text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            <Settings size={16} /> Дизайнер
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
            <Copy size={14} className="inline mr-1" />Комірки
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
                        if (binMode) {
                          setBinSettings((prev) => ({ ...prev, ...LABEL_PRESETS[key] }))
                        } else {
                          setProductSettings((prev) => ({ ...prev, ...LABEL_PRESETS[key] }))
                        }
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
                <NumberField label="Ширина (мм)" value={settings.width_mm} min={20} max={120}
                  onChange={(v) => updateSetting('width_mm', v)} />
                <NumberField label="Висота (мм)" value={settings.height_mm} min={15} max={100}
                  onChange={(v) => updateSetting('height_mm', v)} />
              </div>
              <NumberField label="Відступ (мм)" value={settings.padding_mm} min={0} max={10}
                onChange={(v) => updateSetting('padding_mm', v)} />
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
                <p className="mb-2 text-xs font-semibold text-blue-900">Калібрування принтера</p>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Зсув X (мм)" value={settings.offset_x_mm ?? 0} min={-10} max={10} step={0.5}
                    onChange={(v) => updateSetting('offset_x_mm', v)} />
                  <NumberField label="Зсув Y (мм)" value={settings.offset_y_mm ?? 0} min={-10} max={10} step={0.5}
                    onChange={(v) => updateSetting('offset_y_mm', v)} />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-blue-700">
                  Якщо весь друк зміщений: додатне X — праворуч, Y — вниз. Починайте з 0,5 мм.
                </p>
              </div>
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Шрифти та штрих-код</h3>
              {!binMode ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField label="Назва магазину (pt)" value={settings.font_size_shop} min={4} max={20}
                      onChange={(v) => updateSetting('font_size_shop', v)} />
                    <NumberField label="Назва товару (pt)" value={settings.font_size_title} min={4} max={20}
                      onChange={(v) => updateSetting('font_size_title', v)} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField label="Артикул / SKU (pt)" value={settings.font_size_sku} min={4} max={20}
                      onChange={(v) => updateSetting('font_size_sku', v)} />
                    <NumberField label="Ціна (pt)" value={settings.font_size_price} min={4} max={30}
                      onChange={(v) => updateSetting('font_size_price', v)} />
                  </div>
                  <NumberField label="Рядків назви (макс)" value={settings.max_name_lines} min={1} max={5} step={1}
                    onChange={(v) => updateSetting('max_name_lines', v)} />
                </>
              ) : (
                <NumberField label="Номер комірки (pt)" value={settings.font_size_title} min={4} max={30}
                  onChange={(v) => updateSetting('font_size_title', v)} />
              )}
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Ширина штрих-коду" value={settings.barcode_width_factor} min={0.5} max={2.5}
                  onChange={(v) => updateSetting('barcode_width_factor', v)} />
                <NumberField label="Висота штрих-коду (px)" value={settings.barcode_height} min={10} max={60}
                  onChange={(v) => updateSetting('barcode_height', v)} />
              </div>
              <NumberField label="Цифри штрих-коду (pt)" value={settings.font_size} min={4} max={20}
                onChange={(v) => updateSetting('font_size', v)} />
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Вирівнювання тексту</h3>
              {!binMode ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Назва магазину</label>
                      <select value={settings.align_shop_name || 'left'}
                        onChange={(e) => updateSetting('align_shop_name', e.target.value as any)}
                        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent">
                        <option value="left">Ліворуч</option><option value="center">По центру</option><option value="right">Праворуч</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Назва товару</label>
                      <select value={settings.align_product_name || 'left'}
                        onChange={(e) => updateSetting('align_product_name', e.target.value as any)}
                        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent">
                        <option value="left">Ліворуч</option><option value="center">По центру</option><option value="right">Праворуч</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Артикул / SKU</label>
                      <select value={settings.align_sku || 'left'}
                        onChange={(e) => updateSetting('align_sku', e.target.value as any)}
                        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent">
                        <option value="left">Ліворуч</option><option value="center">По центру</option><option value="right">Праворуч</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Ціна</label>
                      <select value={settings.align_price || 'left'}
                        onChange={(e) => updateSetting('align_price', e.target.value as any)}
                        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent">
                        <option value="left">Ліворуч</option><option value="center">По центру</option><option value="right">Праворуч</option>
                      </select>
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Номер комірки</label>
                  <select value={settings.align_product_name || 'center'}
                    onChange={(e) => updateSetting('align_product_name', e.target.value as any)}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="left">Ліворуч</option><option value="center">По центру</option><option value="right">Праворуч</option>
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Штрих-код</label>
                <select value={settings.align_barcode || 'center'}
                  onChange={(e) => updateSetting('align_barcode', e.target.value as any)}
                  className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="left">Ліворуч</option><option value="center">По центру</option><option value="right">Праворуч</option>
                </select>
              </div>
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Елементи етикетки</h3>
              {(binMode
                ? [
                    { key: 'show_barcode', label: 'Штрих-код' },
                    { key: 'show_barcode_text', label: 'Текст під штрих-кодом' },
                  ]
                : [
                    { key: 'show_shop_name', label: 'Назва магазину' },
                    { key: 'show_product_name', label: 'Назва товару' },
                    { key: 'show_barcode', label: 'Штрих-код' },
                    { key: 'show_barcode_text', label: 'Текст під штрих-кодом' },
                    { key: 'show_sku', label: 'Артикул' },
                    { key: 'show_price', label: 'Ціна' },
                    { key: 'show_storage_bin', label: 'Місце зберігання' },
                  ]
              ).map(({ key, label }) => (
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

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={handleSave} loading={saving} icon={<Save size={16} />}>
                Зберегти налаштування
              </Button>
              <Button
                variant="secondary"
                icon={<Printer size={16} />}
                onClick={() => {
                  try {
                    setPrintPreviewDoc(buildLabelPrintDocument(settings, binMode ? [{ label: 'A-1' }] : [DEMO_PRODUCT], binMode))
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Не вдалося відкрити пробний друк')
                  }
                }}
              >
                Пробна етикетка
              </Button>
            </div>
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
                    ` · Комірка: ${binLabels[binLabels.length - 1] || 'A-1'}`
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
                      onChange={(e) => setSearchQuery(e.target.value)} placeholder="Назва, артикул або штрих-код..." />
                    <p className="mt-1.5 text-[11px] text-gray-400 flex items-center gap-1.5">
                      {scanning
                        ? <><Loader2 size={11} className="animate-spin" /> Шукаю за штрих-кодом...</>
                        : <>📷 Можна піпнути сканером — товар додасться сам, курсор ставити не треба</>}
                    </p>
                    {searchResults.length > 0 && (
                      <div className="mt-2 max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y bg-white">
                        {searchResults.map((p) => (
                          <button key={p.id} onClick={() => addToPrint(p)}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 flex items-center justify-between transition-colors">
                            <span className="font-medium">{p.name}</span>
                            <span className="text-xs text-gray-400 whitespace-nowrap ml-2">
                              {p.sku}{p.barcode ? ` · ${p.barcode}` : ''} · {kopecksToHryvnia(p.retail_price)} ₴
                            </span>
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
                    Поштучне додавання комірки
                  </label>
                  <div className="flex gap-2">
                    <Input value={binInput} onChange={(e) => setBinInput(e.target.value.toUpperCase())}
                      placeholder="Назва комірки: A-3, B12, Стелаж 5..."
                      className="flex-1" />
                    <Button size="sm" onClick={() => { if (binInput.trim()) { setBinLabels((prev) => [...prev, binInput.trim()]); setBinInput('') } }}>
                      <Plus size={14} />
                    </Button>
                  </div>
                </div>

                {/* Масове генерування серії ячейок */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-3">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Масове генерування комірок
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
                    Згенерувати серію комірок
                  </Button>
                </div>
              </div>
            )}

            {/* Список для друку */}
            <Card padding="none">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">
                  {binMode ? 'Комірки' : 'Товари'} ({binMode ? binLabels.length : printItems.reduce((s, i) => s + i.copies, 0)} шт)
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
                    <p className="text-gray-400 text-sm text-center py-8">Додайте назви комірок</p>
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
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
              Розмір <strong>{settings.width_mm}×{settings.height_mm} мм</strong> уже передається принтеру.
              У вікні друку залиште масштаб <strong>100%</strong> і поля <strong>Немає</strong>.
              Не натискайте «Друк» повторно, поки попереднє вікно не закрите — програма також блокує випадковий подвійний запуск.
            </div>

            {tsplAvailable && (
              <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                    Чіткий друк на принтер етикеток
                  </span>
                  <input
                    type="checkbox"
                    checked={tsplSettings.enabled}
                    onChange={(e) => updateTspl({ enabled: e.target.checked })}
                    className="accent-yellow-500 w-4 h-4"
                  />
                </label>
                <p className="text-[11px] leading-relaxed text-gray-500">
                  Етикетки йдуть на термопринтер напряму, без драйвера — максимальна чіткість.
                  Принтер визначається автоматично. Вимикайте лише якщо друк виходить порожній
                  або зі «сміттям».
                </p>
                {tsplSettings.enabled && (
                  <div className="flex gap-2">
                    <select
                      value={tsplSettings.printerName}
                      onChange={(e) => updateTspl({ printerName: e.target.value })}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent bg-white"
                    >
                      <option value="">авто</option>
                      {systemPrinters.map((printer) => (
                        <option key={printer.name} value={printer.name}>{printer.displayName}</option>
                      ))}
                    </select>
                    <Button
                      size="sm" variant="outline"
                      onClick={handleTsplTest}
                      loading={tsplTesting}
                    >
                      Тест
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        open={Boolean(printPreviewDoc)}
        onClose={() => setPrintPreviewDoc(null)}
        title="Попередній перегляд друку"
        size="xl"
      >
        {printPreviewDoc && (
          <div className="space-y-4">
            <div className="flex flex-col gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">{printPreviewDoc.title}</p>
                <p className="text-xs text-blue-700">
                  {printPreviewDoc.count} шт · папір {printPreviewDoc.widthMm}×{printPreviewDoc.heightMm} мм
                </p>
              </div>
              <div className="text-xs text-blue-700">
                У драйвері принтера: масштаб 100%, поля немає.
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-200/70 p-4">
              <div className="mx-auto max-h-[60dvh] overflow-auto rounded-lg bg-white shadow-inner">
                <iframe
                  title="Попередній перегляд етикеток"
                  srcDoc={printPreviewDoc.html}
                  className="block min-h-[55dvh] w-full border-0 bg-white"
                />
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setPrintPreviewDoc(null)}>
                Закрити
              </Button>
              <Button icon={<Printer size={16} />} onClick={handleConfirmPrint}>
                Друк
              </Button>
            </div>
          </div>
        )}
      </Modal>

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
