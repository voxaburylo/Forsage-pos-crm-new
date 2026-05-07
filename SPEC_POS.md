# POS MODULE SPECIFICATION

## Module: Point of Sale (Cashier Terminal)

---

## OVERVIEW

The POS module is the primary tool for the Cashier role. It runs as an Electron desktop application (also usable via web). It processes walk-in sales, returns, debt sales, and cash operations. Designed for speed: a typical sale should complete in under 30 seconds.

---

## SCREEN LAYOUT

```
┌─────────────────────────────────────────────────────────────────┐
│ HEADER: Shift Info | Cashier Name | Internet Status | PRRO     │
├────────────────────────────────┬────────────────────────────────┤
│                                │                                │
│  RECEIPT PANEL (Left 60%)      │  PRODUCT SEARCH (Right 40%)   │
│                                │                                │
│  ┌──────────────────────────┐  │  ┌──────────────────────────┐ │
│  │ Receipt Tabs             │  │  │ [Search Bar - autofocus] │ │
│  │ [Customer A] [Cust B]    │  │  │                          │ │
│  ├──────────────────────────┤  │  ├──────────────────────────┤ │
│  │ Customer: [Quick Select] │  │  │ Search Results           │ │
│  ├──────────────────────────┤  │  │ ┌────────────────────┐   │ │
│  │ Item 1 — qty — price     │  │  │ │ Product A          │   │ │
│  │ Item 2 — qty — price     │  │  │ │  SKU | OEM | Stock │   │ │
│  │ Item 3 — qty — price     │  │  │ │  Price: ₴850       │   │ │
│  │                          │  │  │ └────────────────────┘   │ │
│  │                          │  │  │ ┌────────────────────┐   │ │
│  │                          │  │  │ │ Product B          │   │ │
│  │                          │  │  │ └────────────────────┘   │ │
│  ├──────────────────────────┤  │  │                          │ │
│  │ Subtotal: ₴2,350         │  │  ├──────────────────────────┤ │
│  │ Discount: -₴50           │  │  │ FAVORITES PANEL          │ │
│  │ TOTAL: ₴2,300            │  │  │ [Oil 5W40] [Filter] ...  │ │
│  ├──────────────────────────┤  │  │ [Coolant] [Brake Fl] ... │ │
│  │ [CASH] [CARD] [SPLIT]   │  │  └──────────────────────────┘ │
│  │ [DEBT] [SUSPEND]        │  │                                │
│  └──────────────────────────┘  │                                │
│                                │                                │
├────────────────────────────────┴────────────────────────────────┤
│ FOOTER: [F1 Help] [F2 New Receipt] [F5 Suspend] [F8 Pay]      │
│         [F9 Cash In/Out] [F10 Returns] [F12 Close Shift]       │
└─────────────────────────────────────────────────────────────────┘
```

---

## CORE WORKFLOWS

### 1. Standard Sale

```
1. Cashier scans barcode (or types search query)
2. Product appears in search results
3. Click/Enter adds product to receipt (qty = 1)
4. Repeat for additional items
5. Optionally: attach customer, apply discount
6. Press Pay (F8)
7. Select payment method: Cash / Card / Split
8. If cash: enter amount tendered → system shows change
9. Sale completed → inventory decremented → receipt saved
```

### 2. Barcode Scan Flow

```
Barcode scanner input → Focus always on search bar
  ├── Exact barcode match found → Product added to receipt immediately
  ├── Multiple matches (rare) → Show selection dialog
  └── No match → "Product not found" message + option to search by name
  
Audio feedback:
  ✅ Found: Short confirmation beep
  ❌ Not found: Error tone
```

### 3. Suspended Receipt

```
1. Receipt has items but customer walks away to get another part
2. Cashier presses F5 (Suspend)
3. Receipt saved with is_suspended = true
4. Search bar clears, new empty receipt opens
5. When customer returns: Cashier opens Suspended Receipts panel
6. Click to restore → receipt loads with all items
7. Continue normal sale flow
```

### 4. Multiple Open Checks (Receipt Tabs)

```
1. Receipt for Customer A is open
2. New customer walks in → Cashier presses F2 (New Receipt)
3. Tab [Customer A] becomes inactive, Tab [Customer B] becomes active
4. Work on Customer B's receipt
5. Click Tab [Customer A] to switch back
6. Maximum 5 simultaneous open receipts
```

### 5. Debt Sale

```
1. Normal sale flow up to payment
2. Instead of Cash/Card, Cashier selects DEBT
3. System checks: is customer attached? (Required for debt)
4. System checks: customer's current debt + this sale total ≤ debt limit?
5. Sale processed with is_debt_sale = true
6. Customer's debt_balance incremented by sale total
7. No payment record created (debt is an IOU, not a payment)
```

### 6. Split Payment

```
1. Total: ₴2,300
2. Cashier selects SPLIT
3. Dialog: "Cash amount: [input]" → Cashier enters ₴1,000
4. Remaining ₴1,300 → "Card" or "Bank Transfer"
5. Two payment records created, linked by group_id
6. Sale completed normally
```

### 7. Return Flow

```
1. Cashier presses F10 (Returns)
2. Search by sale number, customer, or product
3. Select original sale
4. Select items to return (partial or full)
5. Select return reason (defective, wrong part, customer changed mind, warranty)
6. Confirm return
7. Sale status → 'returned' (or partial return noted on items)
8. Inventory incremented
9. Refund issued (cash from drawer or card refund initiated)
```

### 8. Shift Close

```
1. Cashier presses F12 (Close Shift)
2. System calculates expected cash:
   opening_cash + cash_sales - cash_refunds + cash_in - cash_out = expected
3. Cashier counts physical cash, enters amount
4. System shows variance (actual - expected)
5. If variance: cashier enters explanation
6. Shift closed → no more sales allowed until new shift opens
7. Shift summary report generated
```

---

## DISCOUNT LOGIC

### Preset Discounts

Quick buttons: 5%, 10%, 15%, 20% — applied to entire receipt or per-item.

### Custom Discount

Cashier can enter a specific amount or percentage.

### Minimum Price Enforcement

```
If (item_price - discount) < min_price:
  → Block the discount
  → Show error: "Price cannot go below minimum (₴X.XX)"
  → Require Owner/Admin override code
```

### Override Flow

```
1. Cashier requests override
2. Owner/Admin enters their PIN/password on the terminal
3. System logs: who overrode, which item, original price, override price, timestamp
4. Sale proceeds with overridden price
```

---

## HOTKEYS

| Key | Action |
|-----|--------|
| F1 | Help / Keyboard shortcuts |
| F2 | New receipt (new tab) |
| F3 | Attach customer to receipt |
| F4 | Apply discount |
| F5 | Suspend current receipt |
| F6 | Open suspended receipts |
| F7 | Add note to receipt |
| F8 | Pay / Complete sale |
| F9 | Cash In / Cash Out |
| F10 | Returns |
| F11 | Quick Last Sale (duplicate) |
| F12 | Close Shift |
| Esc | Cancel current dialog |
| + / - | Increment / decrement quantity on selected item |
| Delete | Remove selected item from receipt |
| Ctrl+F | Focus search bar |

---

## OFFLINE BEHAVIOR

### Internet Lost

```
1. Internet status indicator turns RED
2. Banner: "Інтернет відсутній. Продажі зберігаються локально."
3. Sales continue to process against LOCAL cache:
   - Product data cached on last sync
   - Sales queue stored in local SQLite (Electron)
4. When internet restores:
   - Queue synced to Supabase
   - Inventory reconciled
   - Banner turns GREEN
```

### PRRO (Fiscal Printer) Offline

```
1. PRRO indicator turns RED
2. Banner: "ПРРО офлайн. Фіскальні чеки не друкуються."
3. Sales continue (non-fiscal receipts)
4. Unprinted fiscal receipts queued
5. When PRRO reconnects: queue processed
```

### Crash Recovery

```
1. App crashes or power lost
2. On restart: check for unsaved receipts in local storage
3. If found: restore open receipts
4. Banner: "Відновлено X незавершених чеків"
5. Cashier can continue or discard
```

---

## DUPLICATE SALE DETECTION

If the same combination of (customer_id + items + total) is processed within 5 minutes of a previous sale:

```
WARNING: "Схожий продаж щойно був проведений (₴2,300, 3 хвилини тому). Продовжити?"
[Так, це новий продаж] [Скасувати]
```

---

## RECEIPT NOTE

Cashier can add a free-text note to any receipt (F7). This note:
- Prints on the physical receipt
- Is visible in sale history
- Used for: "delivery arranged", "will pick up tomorrow", "needs invoice"

---

## QUICK LAST SALE

Shortcut to repeat the exact previous sale. Common scenario: customer comes back for the same oil/filter.

```
F11 → Shows last sale details
[Повторити продаж] → Creates new sale with same items
Customer can be changed, quantities can be adjusted
```

---

## POS API ENDPOINTS

```
POST   /api/v1/sales                    — Create/complete sale
GET    /api/v1/sales/:id                — Get sale details
POST   /api/v1/sales/:id/return         — Process return
GET    /api/v1/sales/suspended          — Get suspended receipts
POST   /api/v1/sales/:id/suspend        — Suspend a receipt
POST   /api/v1/sales/:id/resume         — Resume suspended receipt
POST   /api/v1/sales/override-min-price — Override minimum price
POST   /api/v1/shifts/open              — Open cashier shift
POST   /api/v1/shifts/:id/close         — Close shift with count
GET    /api/v1/shifts/current           — Get current open shift
POST   /api/v1/cash-operations          — Record cash in/out
GET    /api/v1/products/search?q=       — Universal product search
GET    /api/v1/products/favorites       — Get favorite products
```

---

## SOUND EFFECTS

| Event | Sound |
|-------|-------|
| Barcode scanned successfully | Short beep (200ms, 800Hz) |
| Barcode not found | Error tone (300ms, 400Hz) |
| Sale completed | Cash register sound |
| Receipt suspended | Soft click |
| Duplicate sale warning | Alert chime |

Audio can be muted in POS settings.
