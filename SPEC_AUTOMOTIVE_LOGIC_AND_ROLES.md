# AUTOMOTIVE SPECIAL LOGIC SPECIFICATION

---

## 1. UNIVERSAL PART IDENTIFICATION

### The Problem

A single physical brake pad can be known by:
- OEM number: `04465-33471` (Toyota's code)
- Supplier article: `GDB1550` (TRW's code for the same pad)
- Internal SKU: `BRK-00421` (your store's code)
- Barcode: `4006633364515` (EAN on the box)
- Another barcode: `8690000012345` (supplier's label barcode)
- Alias: "Колодки Камрі перед" (what your staff calls it)

### The Solution

Universal search must scan ALL identification fields simultaneously. When a customer says "I need 04465-33471" or a cashier scans a barcode or a manager types "Camry brake", the system must find the same product.

### Normalization Rules

Before comparing search input to stored values:

```
Input: "04465-33471"  → Normalized: "0446533471"
Input: "TRW GDB 1550" → Normalized: "TRWGDB1550"
Input: "brk-00421"    → Normalized: "BRK00421"
```

Rules:
1. Remove: spaces, dashes (-), dots (.), slashes (/), underscores (_)
2. Convert to UPPERCASE
3. Trim leading/trailing whitespace

Store normalized versions in dedicated indexed columns for fast lookup.

---

## 2. ANALOG PRIORITY SYSTEM

### Brand Tiers

Every brand in the system is classified into a tier:

| Tier | Description | Example Brands | Typical Price Range |
|------|-------------|----------------|-------------------|
| **Original** | OEM manufacturer parts | Toyota Genuine, BMW Original | 100% (baseline) |
| **Premium** | Top aftermarket brands | TRW, Bosch, Brembo, Sachs | 60-80% of OEM |
| **Standard** | Reliable mid-tier brands | Remsa, Ferodo, Kayaba | 40-60% of OEM |
| **Budget** | Economy brands | Rider, AURORA, local brands | 20-40% of OEM |

### Analog Display Order

When showing analogs for a product:

```
1. Same-tier alternatives first (if customer asked for "premium", show premium first)
2. Then tier up (show what's better)
3. Then tier down (show what's cheaper)
4. Within each tier: sort by stock availability, then by trust_score
```

### Substitute Logic

When searched product is OUT OF STOCK:

```
1. Show "Немає в наявності" (Out of stock)
2. Automatically show: "Доступні аналоги:" (Available analogs)
3. List analogs that ARE in stock, sorted by tier priority
4. If no analogs in stock: show "Можна замовити:" (Can be ordered) with orderable analogs
```

---

## 3. VEHICLE FITMENT

### Fitment Data Model

```
Vehicle: { make, model, year, engine_code, body_code }
Product Fitment: { product_id, make, model, year_from, year_to, engine_code?, body_code? }
```

### Fitment Search Flow

```
Input: Vehicle (make=Toyota, model=Camry, year=2015, engine=2AR-FE)
+ Part type (brake pads, front)

Step 1: Query external fitment API → Get OEM numbers for this vehicle + part type
Step 2: For each OEM number:
  a. Find matching product in internal catalog (by OEM number)
  b. Find all analogs of that product
  c. Check stock for each
Step 3: Return grouped results:
  - In Stock (can sell now)
  - Can Order (from supplier)
  - Not Available (not in catalog at all)
```

### Customer Vehicle Memory

Every customer can have multiple vehicles stored. When a returning customer is identified:
- Their vehicles appear immediately
- "Останнє авто" (Last vehicle) is highlighted
- Parts searched are automatically filtered by vehicle compatibility if a vehicle is selected

---

## 4. SUPPLIER INTELLIGENCE

### Speed Score

Calculated automatically based on order history:

```
speed_score = (orders_delivered_on_time / total_orders) * 100

Recalculated: weekly, based on last 90 days
```

### Supplier Selection Priority

When ordering a part from a supplier:

```
Priority factors:
1. In-stock availability (can they ship now?)
2. Price (cheapest for the same quality tier)
3. Speed score (historically reliable delivery)
4. Lead time (days until delivery)
```

Display in supplier selection:

```
Supplier A — ₴450 — In Stock — Speed: 92/100 — Delivery: 1-2 days
Supplier B — ₴420 — In Stock — Speed: 75/100 — Delivery: 2-3 days  
Supplier C — ₴380 — On Order — Speed: 88/100 — Delivery: 5-7 days
```

---

## 5. FREQUENTLY SOLD TOGETHER

### Data Source

Derived from sales history. Two products are "frequently sold together" if they appear in the same sale more than N times (threshold: 3).

### Use Cases

- POS: After adding brake pads → suggest brake disc, brake cleaner, brake grease
- Order: After ordering a timing belt → suggest tensioner, water pump, coolant

### Display

```
"Часто купують разом:" (Frequently bought together)
┌─────────────────────────────────────┐
│ Гальмівний диск TRW DF1234 — ₴650  │  [Додати]
│ Очисник гальм WURTH — ₴120         │  [Додати]
│ Мастило для напрямних — ₴85        │  [Додати]
└─────────────────────────────────────┘
```

---

## 6. WARRANTY CLAIM FLOW

```
1. Customer brings back a part claiming defect
2. Manager creates warranty claim:
   - Link to original sale
   - Link to product
   - Claim reason (manufacturing defect, premature wear, wrong spec)
   - Photos of the defective part
3. System checks: is the part within warranty period? (based on sale date + brand warranty)
4. If eligible:
   a. Part returned to store (inventory +1 defective)
   b. Supplier return initiated
   c. Customer gets: replacement from stock, or refund, or credit
5. Track claim status: submitted → supplier_review → approved/denied → resolved
6. Analytics: which brands have highest warranty claim rates?
```

---

## 7. LOST ORDER ANALYTICS

When an order is cancelled or lost, capture WHY:

### Cancel Reasons

```
- price_too_high: Customer found cheaper elsewhere
- found_elsewhere: Customer found the part at another store
- wrong_part: Part ordered does not fit customer's vehicle
- customer_changed_mind: Customer no longer needs it
- delivery_too_slow: Waited too long
- other: Free text
```

### Analytics View

```
Lost Order Report — Last 30 Days
├── Price Too High: 35%
├── Found Elsewhere: 25%
├── Delivery Too Slow: 20%
├── Wrong Part: 10%
├── Customer Changed Mind: 8%
└── Other: 2%

Actionable Insight: "35% of lost orders cite price. 
Consider reviewing markup on categories: Brake Pads, Filters."
```

---

## 8. RETURN REASON ANALYTICS

Track why products come back:

```
- defective: Product is defective
- wrong_fitment: Doesn't fit customer's vehicle
- wrong_product: Customer or staff picked wrong item
- customer_changed_mind: No longer needed
- warranty: Warranty claim
- duplicate_purchase: Customer already had it
```

### Analytics View

```
Returns by Reason — Last 30 Days
├── Wrong Fitment: 40% → Action: improve fitment verification
├── Defective: 25% → Action: review brand quality
├── Wrong Product: 15% → Action: improve product identification
├── Customer Changed Mind: 12%
└── Other: 8%
```

---

# ROLE MATRIX SPECIFICATION

## Permission Matrix — Complete

| Permission | Owner | Admin | Manager | Cashier | Storekeeper | STO Viewer |
|-----------|:-----:|:-----:|:-------:|:-------:|:-----------:|:----------:|
| **SYSTEM** | | | | | | |
| Manage tenant settings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manage users | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage roles | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage integrations | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View audit logs | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **PRODUCTS** | | | | | | |
| View products | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit products | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Delete products | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Set prices | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Override min price | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Import products | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **INVENTORY** | | | | | | |
| View inventory | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Create receipts | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Confirm receipts | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Create write-offs | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Run inventory count | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| **SALES (POS)** | | | | | | |
| Process sales | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Apply discounts | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Process returns | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Process debt sales | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Cash in/out | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Open/close shift | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **CUSTOMERS** | | | | | | |
| View customers | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Create/edit customers | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete customers | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View debts | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Set debt limits | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **ORDERS** | | | | | | |
| View orders | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Create/edit orders | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Change order status | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Cancel orders | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **MESSAGES** | | | | | | |
| View messages | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Reply to messages | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Assign leads | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **REPORTS** | | | | | | |
| View all reports | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View own sales report | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| View low stock | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Export reports | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **PAYMENTS** | | | | | | |
| View payment history | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Record payments | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| View reconciliation | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |

## Role Assignment Rules

- **Owner**: One per tenant. Cannot be deleted. Assigned at tenant creation.
- **Admin**: Appointed by Owner. Unlimited per tenant.
- **Manager**: Appointed by Owner or Admin. Handles orders and messaging.
- **Cashier**: Appointed by Owner or Admin. POS-only workflow.
- **Storekeeper**: Appointed by Owner or Admin. Inventory-only workflow.
- **STO Viewer**: Appointed by Owner or Admin. Read-only catalog access for partner repair shops.
