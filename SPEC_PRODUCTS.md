# PRODUCT MODULE SPECIFICATION

## Module: Products & Catalog

---

## OVERVIEW

The Products module is the central catalog of all items sold, ordered, or tracked by the business. It supports the complex identification model used in automotive parts: a single physical part can be identified by internal SKU, OEM number, supplier article, barcode(s), and informal aliases. The module handles pricing tiers, analog relationships, brand categorization, fitment data, and full movement history.

---

## ENTITY RELATIONSHIPS

```
Product 1──N Barcodes
Product 1──N Aliases
Product 1──N SupplierCodes ──1 Supplier
Product 1──N Analogs ──1 Product
Product 1──N Fitment
Product 1──N PriceHistory
Product N──1 Category
Product N──1 Brand
```

---

## UNIVERSAL SEARCH SPECIFICATION

The most critical feature of the product module. When any user searches for a product, the system must search across ALL identification fields simultaneously.

### Search Fields (Priority Order)

1. **Barcode** — exact match against `product_barcodes.barcode`
2. **SKU** — prefix match against `products.sku`
3. **OEM Number** — normalized match against `products.oem_number`
4. **Supplier Article** — normalized match against `products.supplier_article` and `product_supplier_codes.supplier_code`
5. **Name** — full-text search against `products.name`
6. **Alias** — full-text search against `product_aliases.alias`

### Normalization Rules

Before searching, the input must be normalized:

- Remove all spaces, dashes, dots, slashes
- Convert to uppercase
- Example: `04465-33471` → `0446533471`
- Example: `TRW GDB 1550` → `TRWGDB1550`

Store a `normalized_oem` and `normalized_article` column for fast lookup.

### Search Response

Each result must include:

```typescript
interface ProductSearchResult {
  id: string;
  sku: string;
  name: string;
  oem_number: string | null;
  brand_name: string | null;
  brand_tier: 'original' | 'premium' | 'standard' | 'budget';
  retail_price: number;       // kopecks
  qty_on_hand: number;
  qty_reserved: number;
  qty_available: number;      // on_hand - reserved
  photo_url: string | null;   // first photo
  match_field: string;        // which field matched the search
  match_value: string;        // the value that matched
  has_analogs: boolean;
  analog_count: number;
}
```

### Performance Target

- Search must return results in under 200ms for a catalog of 50,000 products
- Use PostgreSQL `tsvector` + GIN index for full-text
- Use B-tree indexes on barcode, SKU, OEM, supplier article
- Consider materialized view for combined search if needed

---

## ANALOG SYSTEM

### Analog Display Logic

When viewing a product, show analogs grouped by brand tier:

```
ORIGINAL (OEM)
  └── Toyota 04465-33471 — ₴1,200 — In Stock (4 pcs)

PREMIUM
  ├── TRW GDB1550 — ₴850 — In Stock (12 pcs)
  └── Bosch 0986AB1234 — ₴900 — Order Only

STANDARD
  ├── Remsa 1234.00 — ₴600 — In Stock (8 pcs)
  └── Ferodo FDB1234 — ₴650 — In Stock (3 pcs)

BUDGET
  └── Rider RD.12345 — ₴350 — In Stock (20 pcs)
```

### Analog Suggestions

When a searched product is out of stock, automatically show available analogs. Priority: same brand tier first, then tier up, then tier down.

### Frequently Sold Together

Track which products are commonly sold together (co-occurrence in sales). Display as "Customers also bought" suggestions.

```sql
-- Materialized view for product co-occurrence
CREATE MATERIALIZED VIEW mv_product_pairs AS
SELECT 
  a.product_id as product_a,
  b.product_id as product_b,
  COUNT(*) as pair_count
FROM sale_items a
JOIN sale_items b ON a.sale_id = b.sale_id AND a.product_id < b.product_id
GROUP BY a.product_id, b.product_id
HAVING COUNT(*) >= 3
ORDER BY pair_count DESC;
```

---

## PRICING LOGIC

### Price Hierarchy

```
purchase_price  — what you paid the supplier
min_price       — absolute minimum (system-enforced floor)
wholesale_price — B2B / bulk price
retail_price    — standard walk-in price
```

### Price Rules

1. `min_price` cannot be bypassed by Cashier or Manager. Only Owner/Admin can override.
2. When a sale item price is set below `min_price`, API returns error `SALE_CREATE_BELOW_MIN_PRICE`
3. Override requires a separate API call: `POST /api/v1/sales/override-min-price` with Owner/Admin auth
4. Every price change creates a record in `product_price_history`
5. Markup calculation displayed in admin: `margin = (retail - purchase) / retail * 100`

### Currency

All prices stored as INTEGER in kopecks (1/100 of UAH). Display formatting happens only at the UI layer.

```typescript
// Format for display
function formatPrice(kopecks: number): string {
  return (kopecks / 100).toFixed(2) + ' ₴';
}
```

---

## PRODUCT CRUD API

### Endpoints

```
GET    /api/v1/products                — List products (paginated, filterable)
GET    /api/v1/products/:id            — Get product detail
POST   /api/v1/products                — Create product
PUT    /api/v1/products/:id            — Update product
DELETE /api/v1/products/:id            — Soft-delete product
GET    /api/v1/products/search?q=      — Universal search
GET    /api/v1/products/:id/analogs    — Get product analogs
POST   /api/v1/products/:id/analogs   — Add analog relationship
GET    /api/v1/products/:id/history    — Get price + movement history
GET    /api/v1/products/:id/fitment   — Get vehicle fitment data
POST   /api/v1/products/import        — Bulk import from CSV/Excel
```

### List Filters

```
?category_id=UUID
?brand_id=UUID
?status=active|inactive|discontinued|order_only
?low_stock=true              — only items below reorder point
?dead_stock=true             — only items with no movement in N days
?has_photo=true|false
?price_min=1000&price_max=5000   — kopecks
?sort=name|sku|price|qty|updated
?order=asc|desc
?page=1&limit=50
```

### Create Product Request

```typescript
interface CreateProductRequest {
  sku: string;                 // required, unique per tenant
  name: string;                // required
  description?: string;
  category_id?: string;
  brand_id?: string;
  oem_number?: string;
  supplier_article?: string;
  purchase_price?: number;     // kopecks
  retail_price?: number;
  wholesale_price?: number;
  min_price?: number;
  reorder_point?: number;
  is_weight_based?: boolean;
  is_quick_cash?: boolean;
  is_order_only?: boolean;
  allows_decimal_qty?: boolean;
  weight_grams?: number;
  barcodes?: string[];
  aliases?: string[];
  photo_urls?: string[];
  notes?: string;
}
```

---

## PRODUCT STATUS LIFECYCLE

```
active ──► inactive (temporarily hidden from sale)
active ──► discontinued (permanently removed from catalog)
active ──► order_only (not stocked, only orderable)
inactive ──► active (re-activated)
discontinued ──► active (rare, requires admin)
order_only ──► active (started stocking)
```

---

## BARCODE HANDLING

### Supported Formats

- EAN-13 (standard retail)
- EAN-8 (short)
- Custom (store-generated)
- Supplier (from supplier label)

### Multiple Barcodes

A product can have multiple barcodes. Common scenario: the same brake pad has one barcode from the manufacturer and another from the supplier's label.

### Barcode Uniqueness

Within a tenant, each barcode value must be unique (cannot belong to two products). If a barcode scan matches, it must resolve to exactly one product.

---

## WEIGHT-BASED PRODUCTS

Some products are sold by weight (fasteners, wire, etc.).

- `is_weight_based: true`
- `allows_decimal_qty: true`
- POS UI shows weight input field instead of quantity counter
- Inventory tracked in grams internally, displayed in kg to user
- Price is per kilogram

---

## QUICK CASH PRODUCTS

Generic items sold without detailed tracking (loose washers, misc fasteners).

- `is_quick_cash: true`
- No barcode required
- No inventory tracking (or simplified tracking)
- Appears in POS "Quick Items" panel
- Sale recorded with generic SKU for accounting purposes

---

## IMPORT/EXPORT

### Import from CSV

```
Columns: sku, name, oem_number, barcode, brand, category, purchase_price, retail_price, qty
```

- Import creates products in `draft` status for review before activation
- Duplicate SKUs are flagged, not overwritten
- Price columns are in UAH (converted to kopecks during import)

### Export to CSV/Excel

All products exportable with all fields. Filter by category/brand/status before export.
