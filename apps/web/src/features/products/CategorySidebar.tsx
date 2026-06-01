import { useState, useEffect, useRef } from 'react'
import { Plus, Tag, Pencil, Trash2, Check, X, FolderOpen, Package } from 'lucide-react'
import { adminApi } from '@/features/admin/adminApi'
import { toast } from '@/components/ui/Toast'

export interface Category { id: string; name: string; sort_order: number }
export interface Brand    { id: string; name: string }

interface CategorySidebarProps {
  categories: Category[]
  brands: Brand[]
  activeCategory: string
  activeBrand: string
  onCategory: (id: string) => void
  onBrand: (id: string) => void
  onReload: () => void
  isAdmin: boolean
}

export function CategorySidebar({
  categories,
  brands,
  activeCategory,
  activeBrand,
  onCategory,
  onBrand,
  onReload,
  isAdmin,
}: CategorySidebarProps) {
  const [newCatName, setNewCatName]         = useState('')
  const [addingCat, setAddingCat]           = useState(false)
  const [savingCat, setSavingCat]           = useState(false)
  const [editingId, setEditingId]           = useState<string | null>(null)
  const [editName, setEditName]             = useState('')
  const [showAllBrands, setShowAllBrands]   = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (addingCat) inputRef.current?.focus() }, [addingCat])

  async function handleAddCat() {
    if (!newCatName.trim()) return
    setSavingCat(true)
    try {
      await adminApi.createCategory(newCatName.trim())
      setNewCatName(''); setAddingCat(false)
      onReload(); toast.success('Категорію додано')
    } catch { toast.error('Помилка') }
    finally { setSavingCat(false) }
  }

  async function handleRenameCat(id: string) {
    if (!editName.trim()) return
    try {
      await adminApi.updateCategory(id, editName.trim())
      setEditingId(null)
      onReload(); toast.success('Перейменовано')
    } catch { toast.error('Помилка') }
  }

  async function handleDeleteCat(cat: Category) {
    if (!confirm(`Видалити категорію "${cat.name}"? Товари залишаться без категорії.`)) return
    try {
      await adminApi.deleteCategory(cat.id)
      if (activeCategory === cat.id) onCategory('')
      onReload(); toast.success('Видалено')
    } catch { toast.error('Помилка') }
  }

  const visibleBrands = showAllBrands ? brands : brands.slice(0, 10)

  return (
    <div className="w-52 shrink-0 flex flex-col gap-4 overflow-y-auto pr-1">

      {/* Категорії */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Tag size={12} /> Категорії
          </span>
          {isAdmin && (
            <div className="flex items-center gap-0.5">
              <button onClick={() => setAddingCat(!addingCat)}
                className="text-yellow-500 hover:text-yellow-600 p-0.5 rounded transition-colors" title="Додати категорію">
                <Plus size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Форма нової категорії */}
        {addingCat && (
          <div className="flex gap-1 mb-2">
            <input ref={inputRef} value={newCatName} onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCat(); if (e.key === 'Escape') setAddingCat(false) }}
              placeholder="Назва категорії"
              className="flex-1 text-xs border border-yellow-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-yellow-300" />
            <button onClick={handleAddCat} disabled={savingCat}
              className="text-green-600 hover:text-green-700 p-1"><Check size={14} /></button>
            <button onClick={() => { setAddingCat(false); setNewCatName('') }}
              className="text-gray-400 hover:text-gray-600 p-1"><X size={14} /></button>
          </div>
        )}

        {/* Всі товари */}
        <button onClick={() => onCategory('')}
          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 mb-0.5 ${
            !activeCategory ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
          }`}>
          <FolderOpen size={14} className="shrink-0" />
          <span className="truncate">Всі товари</span>
        </button>

        {/* Список категорій */}
        <div className="space-y-0.5">
          {categories.map((cat) => (
            <div key={cat.id} className="group relative">
              {editingId === cat.id ? (
                <div className="flex gap-1 py-0.5">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRenameCat(cat.id); if (e.key === 'Escape') setEditingId(null) }}
                    className="flex-1 text-xs border border-yellow-300 rounded px-2 py-1 focus:outline-none" />
                  <button onClick={() => handleRenameCat(cat.id)} className="text-green-500"><Check size={13} /></button>
                  <button onClick={() => setEditingId(null)} className="text-gray-400"><X size={13} /></button>
                </div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onCategory(cat.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onCategory(cat.id) }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 cursor-pointer ${
                    activeCategory === cat.id ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
                  }`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0 mt-px" />
                  <span className="flex-1 truncate">{cat.name}</span>
                  {isAdmin && (
                    <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(cat.id); setEditName(cat.name) }}
                        className="text-gray-400 hover:text-blue-500 p-0.5 rounded"
                        aria-label="Перейменувати">
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteCat(cat) }}
                        className="text-gray-400 hover:text-red-500 p-0.5 rounded"
                        aria-label="Видалити">
                        <Trash2 size={11} />
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Бренди */}
      {brands.length > 0 && (
        <div>
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Package size={12} /> Бренди
          </p>
          <button onClick={() => onBrand('')}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors mb-0.5 ${
              !activeBrand ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
            }`}>
            Всі бренди
          </button>
          <div className="space-y-0.5">
            {visibleBrands.map((b) => (
              <button key={b.id} onClick={() => onBrand(b.id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition-colors truncate ${
                  activeBrand === b.id ? 'bg-yellow-50 text-yellow-700 font-semibold border border-yellow-200' : 'text-gray-600 hover:bg-gray-100'
                }`}>
                {b.name}
              </button>
            ))}
          </div>
          {brands.length > 10 && (
            <button onClick={() => setShowAllBrands(!showAllBrands)}
              className="text-xs text-blue-500 hover:text-blue-700 mt-1 px-2.5">
              {showAllBrands ? 'Сховати' : `Ще ${brands.length - 10}...`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
