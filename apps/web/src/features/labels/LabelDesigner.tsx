import { useState, useEffect, useCallback } from 'react'
import { Rnd } from 'react-rnd'
import { Save, Printer, Plus, Trash2, Copy, Settings, Tag, Move } from 'lucide-react'
import { adminApi } from '@/features/admin/adminApi'
import { productApi } from '@/features/products/productApi'
import type { Product } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

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
}

const DEFAULT_LABEL: LabelSettings = {
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
}

type PosKey = 'pos_shop_name' | 'pos_product_name' | 'pos_barcode' | 'pos_sku' | 'pos_price' | 'pos_bin'

// ================================================================
// Preview-компонент етикетки (рендериться в реальному часі)
// ================================================================
function LabelPreview({ settings, product, binLabel, onPosChange }:
  { settings: LabelSettings; product?: Product | null; binLabel?: string; onPosChange?: (key: PosKey, pos: { x: number; y: number }) => void }) {
  const shopName = 'Форсаж'
  // Більший масштаб для зручного перетягування
  const previewScale = 5
  const pw = settings.width_mm * previewScale
  const ph = settings.height_mm * previewScale

  type RndItem = { key: PosKey; visible: boolean; children: React.ReactNode; defaultPos?: { x: number; y: number } }

  const items: RndItem[] = []

  if (settings.show_shop_name) {
    items.push({
      key: 'pos_shop_name',
      visible: settings.show_shop_name,
      defaultPos: settings.pos_shop_name,
      children: <div style={{ fontSize: settings.font_size_shop * previewScale + 'px', color: '#888' }}>{shopName}</div>,
    })
  }

  if (binLabel) {
    items.push({
      key: 'pos_bin',
      visible: true,
      defaultPos: settings.pos_bin,
      children: <div style={{
        fontSize: Math.min(settings.font_size_title * previewScale, settings.width_mm * 1.5) + 'px',
        fontWeight: 700, textAlign: 'center',
      }}>{binLabel}</div>,
    })
  } else if (product) {
    if (settings.show_product_name) {
      items.push({
        key: 'pos_product_name',
        visible: settings.show_product_name,
        defaultPos: settings.pos_product_name,
        children: <div style={{ fontSize: settings.font_size_title * previewScale + 'px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{product.name}</div>,
      })
    }
    if (settings.show_barcode && product.barcode) {
      items.push({
        key: 'pos_barcode',
        visible: settings.show_barcode,
        defaultPos: settings.pos_barcode,
        children: <div style={{ fontSize: settings.font_size * previewScale + 'px', color: '#999', textAlign: 'center' }}>[{product.barcode}]</div>,
      })
    }
    if (settings.show_sku || settings.show_storage_bin) {
      items.push({
        key: 'pos_sku',
        visible: settings.show_sku,
        defaultPos: settings.pos_sku,
        children: <div style={{ fontSize: settings.font_size_sku * previewScale + 'px', color: '#888' }}>
          {settings.show_sku && product.sku}
          {settings.show_storage_bin && (product as any).storage_bin && <span> · {(product as any).storage_bin}</span>}
        </div>,
      })
    }
    if (settings.show_price) {
      items.push({
        key: 'pos_price',
        visible: settings.show_price,
        defaultPos: settings.pos_price,
        children: <div style={{ fontSize: settings.font_size_price * previewScale + 'px', fontWeight: 700 }}>{kopecksToHryvnia(product.retail_price)} ₴</div>,
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
      {items.map((item) => {
        const pos = item.defaultPos || { x: 5, y: 5 }
        return (
          <Rnd
            key={item.key}
            position={{ x: Math.round(pw * pos.x / 100), y: Math.round(ph * pos.y / 100) }}
            onDragStop={(_e, d) => {
              const newX = Math.round((d.x / pw) * 100)
              const newY = Math.round((d.y / ph) * 100)
              onPosChange?.(item.key, { x: Math.max(0, Math.min(95, newX)), y: Math.max(0, Math.min(95, newY)) })
            }}
            bounds="parent"
            enableResizing={false}
            style={{ zIndex: 10 }}
          >
            <div className="relative group cursor-move" style={{ display: 'inline-block' }}>
              {item.children}
            </div>
          </Rnd>
        )
      })}
      {/* Grid dots hint */}
      <div className="absolute inset-0 pointer-events-none opacity-10"
        style={{ backgroundImage: 'radial-gradient(circle, #000 0.5px, transparent 0.5px)', backgroundSize: '8px 8px' }} />
    </div>
  )
}

// ================================================================
// Друк етикеток
// ================================================================
function printLabels(settings: LabelSettings, items: Array<Product | { label: string }>, isBins: boolean) {
  const shopName = 'Форсаж'
  const labelsHtml = items.map((item) => {
    const product = isBins ? null : item as Product
    const binLabel = isBins ? (item as any).label : null

    let body = ''

    if (settings.show_shop_name) {
      body += `<div style="font-size:${settings.font_size}px;color:#666;">${shopName}</div>`
    }

    if (binLabel) {
      body += `<div style="font-size:${Math.min(settings.font_size * 4, settings.width_mm * 0.7)}px;font-weight:700;text-align:center;margin:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${binLabel}</div>`
    } else if (product) {
      if (settings.show_product_name) {
        body += `<div style="font-size:${settings.font_size + 2}px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${product.name}</div>`
      }
      if (settings.show_barcode && product.barcode) {
        body += `<div style="text-align:center;margin:1mm 0;"><svg id="bc-${product.id}"></svg></div>`
      }
      body += `<div style="display:flex;justify-content:space-between;align-items:baseline;">`
      body += `<div style="font-size:${settings.font_size - 1}px;color:#666;">`
      if (settings.show_sku) body += product.sku
      if (settings.show_storage_bin && (product as any).storage_bin) body += ` · ${(product as any).storage_bin}`
      body += `</div>`
      if (settings.show_price) body += `<div style="font-size:${settings.font_size + 5}px;font-weight:700;">${kopecksToHryvnia(product.retail_price)} ₴</div>`
      body += `</div>`
    }

    const jsCode = product?.barcode
      ? `JsBarcode('#bc-${product.id}', '${product.barcode}', { width: 1.2, height: ${settings.barcode_height}, fontSize: ${settings.font_size + 1}, margin: 0, displayValue: true });`
      : ''

    return `
      <div class="label">
        ${body}
      </div>
      <script>${jsCode}</script>
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
    display: flex; flex-direction: column;
    justify-content: space-between;
    page-break-inside: avoid;
    page-break-after: always;
  }
  .label svg { max-width: ${w - settings.padding_mm * 2}mm; max-height: ${settings.barcode_height * 1.2}px; }
</style></head><body>
  ${labelsHtml}
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3/dist/JsBarcode.all.min.js"></script>
  <script>
    try { ${items.filter(i => !isBins && (i as Product).barcode).map((i) => {
      const p = i as Product
      return `JsBarcode('#bc-${p.id}', '${p.barcode}', { width: 1.2, height: ${settings.barcode_height}, fontSize: ${settings.font_size + 1}, margin: 0, displayValue: true });`
    }).join('\n')} } catch(e) {}
    window.onload = function() { setTimeout(function() { window.print(); window.close(); }, 500); };
  </script>
</body></html>`

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.top = '-9999px'
  iframe.style.width = '0'
  iframe.style.height = '0'
  document.body.appendChild(iframe)
  iframe.contentDocument?.open()
  iframe.contentDocument?.write(html)
  iframe.contentDocument?.close()
  setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe) }, 30000)
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

  // Завантажуємо налаштування
  useEffect(() => {
    adminApi.getSettings()
      .then((res) => {
        if (res.data.label_settings) {
          setSettings({ ...DEFAULT_LABEL, ...res.data.label_settings })
        }
      })
      .catch(() => toast.error('Помилка завантаження налаштувань'))
      .finally(() => setLoading(false))
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
      await adminApi.updateSettings({ label_settings: settings as any })
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
      <div className="flex gap-2 mb-6">
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

      {tab === 'design' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Налаштування */}
          <div className="space-y-4">
            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Розміри</h3>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Ширина (мм)" type="number" min={20} max={120} value={settings.width_mm}
                  onChange={(e) => updateSetting('width_mm', parseInt(e.target.value) || 40)} />
                <Input label="Висота (мм)" type="number" min={15} max={100} value={settings.height_mm}
                  onChange={(e) => updateSetting('height_mm', parseInt(e.target.value) || 30)} />
              </div>
              <Input label="Відступ (мм)" type="number" min={0} max={10} value={settings.padding_mm}
                onChange={(e) => updateSetting('padding_mm', parseInt(e.target.value) || 2)} />
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Шрифти та штрих-код</h3>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Назва магазину" type="number" min={4} max={20} value={settings.font_size_shop}
                  onChange={(e) => updateSetting('font_size_shop', parseInt(e.target.value) || 6)} />
                <Input label="Назва товару" type="number" min={4} max={20} value={settings.font_size_title}
                  onChange={(e) => updateSetting('font_size_title', parseInt(e.target.value) || 7)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Артикул / SKU" type="number" min={4} max={20} value={settings.font_size_sku}
                  onChange={(e) => updateSetting('font_size_sku', parseInt(e.target.value) || 5)} />
                <Input label="Ціна" type="number" min={4} max={30} value={settings.font_size_price}
                  onChange={(e) => updateSetting('font_size_price', parseInt(e.target.value) || 12)} />
              </div>
              <Input label="Базовий розмір (штрих-код)" type="number" min={4} max={20} value={settings.font_size}
                onChange={(e) => updateSetting('font_size', parseInt(e.target.value) || 7)} />
              <Input label="Висота штрих-коду (px)" type="number" min={10} max={60} value={settings.barcode_height}
                onChange={(e) => updateSetting('barcode_height', parseInt(e.target.value) || 28)} />
            </Card>

            <Card className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-800 border-b border-gray-100 pb-2">Елементи етикетки</h3>
              {[
                { key: 'show_shop_name', label: 'Назва магазину' },
                { key: 'show_product_name', label: 'Назва товару' },
                { key: 'show_barcode', label: 'Штрих-код' },
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
              <div className="flex items-center justify-center bg-gray-100 rounded-xl p-4 min-h-[200px]">
                <LabelPreview settings={settings} product={printItems[0] || null} onPosChange={handlePosChange} />
              </div>
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-gray-400">
                  [{settings.width_mm}×{settings.height_mm}mm]
                  {printItems.length > 0 ? ` · ${printItems[0].name}` : ''}
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
            {/* Перемикач: Товари / Ячейки */}
            <div className="flex gap-2">
              <button onClick={() => setBinMode(false)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  !binMode ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600'
                }`}>
                <Tag size={14} className="inline mr-1" />Товари
              </button>
              <button onClick={() => setBinMode(true)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  binMode ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600'
                }`}>
                <Copy size={14} className="inline mr-1" />Ячейки (Bins)
              </button>
            </div>

            {!binMode ? (
              <>
                <Input label="Пошук товарів" value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)} placeholder="Назва, артикул..." />
                {searchResults.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y">
                    {searchResults.map((p) => (
                      <button key={p.id} onClick={() => addToPrint(p)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 flex items-center justify-between transition-colors">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-xs text-gray-400">{p.sku} · {kopecksToHryvnia(p.retail_price)} ₴</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex gap-2">
                <Input value={binInput} onChange={(e) => setBinInput(e.target.value.toUpperCase())}
                  placeholder="Назва ячейки: A-3, B12, Стелаж 5..."
                  className="flex-1" />
                <Button size="sm" onClick={() => { if (binInput.trim()) { setBinLabels((prev) => [...prev, binInput.trim()]); setBinInput('') } }}>
                  <Plus size={14} />
                </Button>
              </div>
            )}

            {/* Список для друку */}
            <Card padding="none">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">
                  {binMode ? 'Ячейки' : 'Товари'} ({binMode ? binLabels.length : printItems.reduce((s, i) => s + i.copies, 0)} шт)
                </span>
                <div className="flex gap-2">
                  {!binMode && printItems.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setPrintItems([])}>Очистити</Button>
                  )}
                  {binMode && binLabels.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setBinLabels([])}>Очистити</Button>
                  )}
                </div>
              </div>
              {!binMode ? (
                <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                  {printItems.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-8">Додайте товари через пошук</p>
                  ) : (
                    printItems.map((item) => (
                      <div key={item.id} className="px-4 py-2 flex items-center justify-between text-sm">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{item.name}</p>
                          <p className="text-xs text-gray-400">{item.sku}</p>
                        </div>
                        <div className="flex items-center gap-2 ml-2">
                          <button onClick={() => setPrintItems((prev) => prev.map((p) => p.id === item.id ? { ...p, copies: Math.max(1, p.copies - 1) } : p))}
                            className="w-6 h-6 bg-gray-100 rounded text-gray-600 hover:bg-gray-200">−</button>
                          <span className="w-6 text-center font-medium">{item.copies}</span>
                          <button onClick={() => setPrintItems((prev) => prev.map((p) => p.id === item.id ? { ...p, copies: p.copies + 1 } : p))}
                            className="w-6 h-6 bg-gray-100 rounded text-gray-600 hover:bg-gray-200">+</button>
                          <button onClick={() => setPrintItems((prev) => prev.filter((p) => p.id !== item.id))}
                            className="ml-1 text-red-300 hover:text-red-500"><Trash2 size={14} /></button>
                        </div>
                      </div>
                    ))
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
              <div className="flex items-center justify-center bg-gray-100 rounded-xl p-4 min-h-[150px]">
                {binMode ? (
                  <LabelPreview settings={settings} binLabel={binLabels[binLabels.length - 1] || 'A-1'} />
                ) : (
                  <LabelPreview settings={settings} product={printItems[0] || null} />
                )}
              </div>
            </Card>

            <Button onClick={handlePrint} className="w-full" icon={<Printer size={16} />}>
              Друк ({binMode ? binLabels.length : printItems.reduce((s, i) => s + i.copies, 0)} шт)
            </Button>
          </div>
        </div>
      )}
    </Layout>
  )
}
