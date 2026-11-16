import { describe, expect, it } from 'vitest'
import { DEFAULT_QUICK_ITEMS, filterQuickGallery, matchCategoryIds, mergeQuickGallery, quickGallerySources } from './quickGalleryModel'

describe('till quick goods gallery', () => {
  it('keeps everything the old tiles offered: food categories and tile articles', () => {
    expect(quickGallerySources(DEFAULT_QUICK_ITEMS)).toEqual({
      categoryNames: ['Кава та напої', 'Снеки та хотдоги'],
      skus: ['CAM13', 'CAM-R13', 'CAM-R14', 'PACKET'],
    })
  })

  it('matches categories regardless of case and spaces', () => {
    const categories = [{ id: 'a', name: 'кава  та напої' }, { id: 'b', name: 'Фільтри' }, { id: 'c', name: 'Снеки та хотдоги ' }]
    expect(matchCategoryIds(categories, ['Кава та напої', 'Снеки та хотдоги'])).toEqual(['a', 'c'])
  })

  it('shows each product once, photos first, stable order', () => {
    const coffee = { id: '1', sku: 'COF', name: 'Кава', retail_price: 3000, photo_url: 'x.jpg', category: { name: 'Кава та напої' } }
    const packet = { id: '2', sku: 'PACKET', name: 'Пакет', retail_price: 500, photo_url: null }
    const hotdog = { id: '3', sku: 'HD', name: 'Хотдог', retail_price: 6000, photo_url: null, category: { name: 'Снеки' } }
    const merged = mergeQuickGallery([[packet, coffee], [coffee, hotdog], [packet]])
    expect(merged.map(p => p.id)).toEqual(['1', '2', '3'])
    expect(filterQuickGallery(merged, 'КАВ').map(p => p.id)).toEqual(['1'])
    expect(filterQuickGallery(merged, 'hd').map(p => p.id)).toEqual(['3'])
    expect(filterQuickGallery(merged, '  ')).toHaveLength(3)
  })
})
