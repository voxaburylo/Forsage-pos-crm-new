import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import * as productController from '../controllers/productController.js'

const router = Router()

// Все маршруты требуют авторизации
router.use(requireAuth)

// GET /api/v1/products/export — експорт товарів у CSV
router.get('/export', requireRole('owner', 'admin', 'manager'), productController.exportCsv)

// GET /api/v1/products/generate-barcode-only — згенерувати унікальний штрих-код без прив'язки до товару
router.get('/generate-barcode-only', requireRole('owner', 'admin', 'storekeeper'), productController.generateBarcodeOnly)

// POST /api/v1/products/import — імпорт товарів (upsert по sku або barcode)
router.post('/import', requireRole('owner', 'admin', 'manager'), productController.importBulk)

// GET /api/v1/products/search — быстрый поиск для POS (до CRUD чтобы не конфликтовало с /:id)
router.get('/search', productController.search)

// GET /api/v1/products/favorites — швидкі товари для POS
router.get('/favorites', productController.getFavorites)

// GET /api/v1/products — список с поиском и фильтрами
router.get('/', productController.getList)

// POST /api/v1/products/bulk-update — масове оновлення товарів
router.post('/bulk-update', requireRole('owner', 'admin', 'manager'), productController.bulkUpdate)

// GET /api/v1/products/:id — карточка товара
router.get('/:id', productController.getOne)

// GET /api/v1/products/:id/price-history — история цен
router.get('/:id/price-history', requireRole('owner', 'admin', 'manager'), productController.getPriceHistory)

// GET /api/v1/products/:id/analogs — аналоги товара
router.get('/:id/analogs', productController.getAnalogs)

// POST /api/v1/products/:id/analogs — додати аналог
router.post('/:id/analogs', requireRole('owner', 'admin', 'storekeeper'), productController.addAnalog)

// DELETE /api/v1/products/:id/analogs/:analogId — видалити аналог
router.delete('/:id/analogs/:analogId', requireRole('owner', 'admin', 'storekeeper'), productController.removeAnalog)

// Власна база OE та крос-номерів — масова вставка з буфера обміну
router.get('/:id/cross-numbers', productController.getCrossNumbers)
router.post('/:id/cross-numbers', requireRole('owner', 'admin', 'manager', 'storekeeper'), productController.addCrossNumbers)
router.delete('/:id/cross-numbers/:crossNumberId', requireRole('owner', 'admin', 'manager', 'storekeeper'), productController.removeCrossNumber)

// GET /api/v1/products/:id/cobuy — супутні товари
router.get('/:id/cobuy', productController.getCobuy)

// POST /api/v1/products/:id/cobuy — додати супутні товари
router.post('/:id/cobuy', requireRole('owner', 'admin', 'storekeeper'), productController.addCobuy)

// DELETE /api/v1/products/:id/cobuy/:recommendedId — видалити супутній зв'язок
router.delete('/:id/cobuy/:recommendedId', requireRole('owner', 'admin', 'storekeeper'), productController.removeCobuy)

// POST /api/v1/products — создать товар
router.post('/', requireRole('owner', 'admin', 'manager', 'storekeeper'), productController.createOne)

// PUT /api/v1/products/:id — обновить товар
router.put('/:id', requireRole('owner', 'admin', 'manager', 'storekeeper'), productController.updateOne)

// DELETE /api/v1/products/:id — soft delete
router.delete('/:id', requireRole('owner', 'admin'), productController.deleteOne)

// GET /api/v1/products/:id/stock — доступний залишок
router.get('/:id/stock', productController.getStock)

// PUT /api/v1/products/:id/stock — коррекция остатка
router.put('/:id/stock', requireRole('owner', 'admin', 'storekeeper'), productController.updateStock)

// GET /api/v1/products/:id/fitment — сумісність з авто
router.get('/:id/fitment', productController.getFitment)

// GET /api/v1/products/:id/history — історія товару (ціни + рух)
router.get('/:id/history', requireRole('owner', 'admin', 'manager'), productController.getHistory)

// GET /api/v1/products/:id/supplier-prices — порівняння закупівельних цін постачальників
router.get('/:id/supplier-prices', requireRole('owner', 'admin', 'manager', 'storekeeper'), productController.getSupplierPrices)

// POST /api/v1/products/:id/generate-barcode — генерувати внутрішній штрих-код
router.post('/:id/generate-barcode', requireRole('owner', 'admin', 'storekeeper'), productController.generateBarcode)

// POST /api/v1/products/merge — злиття дублікатів
router.post('/merge', requireRole('owner', 'admin'), productController.merge)

export default router
