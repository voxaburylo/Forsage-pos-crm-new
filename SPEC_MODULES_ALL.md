# MODULE SPECIFICATIONS INDEX

## Remaining Modules — Complete Specs

---

# SPEC: AUTH & ROLES

## Endpoints

```
POST /api/v1/auth/register     — Create account (Owner/Admin only)
POST /api/v1/auth/login         — Login with phone + password
POST /api/v1/auth/refresh       — Refresh JWT token
POST /api/v1/auth/logout        — Invalidate token
POST /api/v1/auth/change-password — Change own password
POST /api/v1/auth/reset-password  — Admin resets user password
```

## JWT Payload

```typescript
{
  sub: string;          // user_id
  role: UserRole;       // enum
  tenant_id: string;    // tenant isolation
  iat: number;          // issued at
  exp: number;          // expires (15 min for access, 7 days for refresh)
}
```

## Login Flow

1. User submits phone + password
2. Server validates against Supabase Auth
3. Server generates JWT with role and tenant_id
4. Client stores access_token in memory, refresh_token in httpOnly cookie
5. Every API request includes `Authorization: Bearer <access_token>`
6. When access_token expires, client auto-refreshes using refresh_token

## Role Guard Middleware

```typescript
function requireRole(...roles: UserRole[]) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'AUTH_FORBIDDEN', message: 'Insufficient permissions' }});
    }
    next();
  };
}

// Usage:
router.delete('/users/:id', requireRole('owner', 'admin'), deleteUser);
```

---

# SPEC: CUSTOMERS (CRM)

## Endpoints

```
GET    /api/v1/customers             — List (paginated, searchable)
GET    /api/v1/customers/:id         — Detail with vehicles, summary stats
POST   /api/v1/customers             — Create
PUT    /api/v1/customers/:id         — Update
DELETE /api/v1/customers/:id         — Soft-delete
POST   /api/v1/customers/quick       — Quick create (phone + name only)
GET    /api/v1/customers/:id/timeline — Full activity timeline
GET    /api/v1/customers/:id/debts   — Debt history
POST   /api/v1/customers/:id/vehicles — Add vehicle
PUT    /api/v1/customers/:id/vehicles/:vid — Update vehicle
DELETE /api/v1/customers/:id/vehicles/:vid — Remove vehicle
```

## Customer Timeline

Unified chronological feed of all customer activity:

```typescript
interface TimelineEvent {
  type: 'sale' | 'order' | 'payment' | 'message' | 'debt_change' | 'vehicle_added' | 'note';
  timestamp: string;
  summary: string;
  reference_id: string;   // sale_id, order_id, etc.
  actor: string;          // who performed the action
}
```

## Quick Create

For cashier use during sale. Minimum fields: phone + name. Everything else optional and addable later.

```
POST /api/v1/customers/quick
Body: { phone: "+380501234567", name: "Олександр" }
Returns: { id: "uuid", phone, name }
```

## Debt Management

- `debt_balance` on customer record is the source of truth
- Incremented when `is_debt_sale` sale is completed
- Decremented when `debt_repayment` payment is received
- Debt aging: track how old each unpaid sale is
- Debt limit: configurable per customer (default: unlimited, but Owner can set)

---

# SPEC: INVENTORY

## Endpoints

```
POST   /api/v1/inventory/receipts           — Create supplier receipt
GET    /api/v1/inventory/receipts           — List receipts
GET    /api/v1/inventory/receipts/:id       — Receipt detail with items
POST   /api/v1/inventory/receipts/:id/confirm — Confirm receipt (update stock)
POST   /api/v1/inventory/writeoffs          — Create write-off
GET    /api/v1/inventory/writeoffs          — List write-offs
POST   /api/v1/inventory/sessions           — Start inventory count session
POST   /api/v1/inventory/sessions/:id/items — Submit count for an item
POST   /api/v1/inventory/sessions/:id/complete — Complete session (apply variances)
POST   /api/v1/inventory/reserves           — Create reserve
DELETE /api/v1/inventory/reserves/:id       — Release reserve
GET    /api/v1/inventory/low-stock          — Low stock report
GET    /api/v1/inventory/dead-stock         — Dead stock report (no movement > N days)
```

## Receipt Confirmation Flow

```
1. Storekeeper creates receipt (draft): products + quantities + prices
2. Storekeeper verifies physical goods match receipt
3. Storekeeper confirms receipt
4. System: BEGIN TRANSACTION
   - For each item: UPDATE products SET qty_on_hand = qty_on_hand + receipt_qty
   - UPDATE products SET purchase_price = receipt_price (optional auto-update)
   - UPDATE inventory_receipts SET status = 'confirmed'
   COMMIT
5. Stock levels now reflect the new delivery
```

## Inventory Count Process

```
1. Start session (optionally: filter to category or location)
2. System snapshots current qty_on_hand for each product in scope
3. Staff counts physical items, enters counted_qty for each product
4. System calculates variance = counted_qty - expected_qty
5. Review variances (positive = surplus, negative = shrinkage)
6. Complete session → system adjusts qty_on_hand to match counted_qty
7. Variances logged for audit trail
```

---

# SPEC: ORDERS

## Status Transitions

```
draft ──► quoted         (manager sets price)
quoted ──► prepaid       (customer pays deposit)
quoted ──► ordered_from_supplier (ordered without prepayment)
prepaid ──► ordered_from_supplier
ordered_from_supplier ──► arrived (goods received from supplier)
arrived ──► issued       (customer picks up / delivered)
issued ──► completed     (order fully closed)

Any status ──► cancelled  (with cancel_reason)
completed ──► lost        (retrospective: customer returned, etc.)
```

Invalid transitions must be rejected by the API.

## Order Endpoints

```
GET    /api/v1/orders              — List (filterable by status, customer, date)
GET    /api/v1/orders/:id          — Detail with items, attachments, status history
POST   /api/v1/orders              — Create order
PUT    /api/v1/orders/:id          — Update order details
POST   /api/v1/orders/:id/status   — Change status (with validation)
POST   /api/v1/orders/:id/attachments — Upload attachment
GET    /api/v1/orders/overdue      — Orders past promised_date
GET    /api/v1/orders/analytics/lost — Lost order reasons breakdown
```

## Promise Timer

- `promised_date` set when order is quoted
- Cron job checks daily: if `NOW() > promised_date` AND status not terminal → set `is_overdue = true`
- Overdue orders appear in dashboard alert panel
- Manager sees: "3 overdue orders" with details

## Unknown Item Requests

Customer describes a part but cannot identify it. Order created with:
- `product_id: null`
- `custom_description: "Front left something, makes noise when braking, 2015 Toyota Camry"`
- Manager researches, finds the correct product, updates the order

---

# SPEC: PAYMENTS LEDGER

## Endpoints

```
POST   /api/v1/payments              — Record payment
GET    /api/v1/payments              — List payments (filterable)
GET    /api/v1/payments/:id          — Payment detail
POST   /api/v1/payments/debt-repayment — Record debt repayment
GET    /api/v1/payments/reconciliation — Shift cash reconciliation
```

## Split Payment Logic

```typescript
// Creating a split payment
POST /api/v1/payments
{
  sale_id: "uuid",
  splits: [
    { method: "cash", amount: 100000 },      // ₴1,000
    { method: "terminal", amount: 130000 }    // ₴1,300
  ]
}

// Server creates two payment records with shared group_id
// Validates: sum of splits == sale total
```

## Cash Reconciliation

```
Expected Cash = 
  shift.opening_cash
  + SUM(cash sales during shift)
  - SUM(cash refunds during shift)
  + SUM(cash_in operations)
  - SUM(cash_out operations)
  + SUM(cash debt repayments)

Variance = actual_counted - expected
```

---

# SPEC: MESSAGING

## Telegram Bot Setup

1. Create bot via BotFather
2. Set webhook URL to Supabase Edge Function
3. Edge Function receives updates, processes messages, stores in DB
4. CRM frontend subscribes to Supabase Realtime for new messages

## Message Processing Pipeline

```
Telegram Update received
  │
  ├── Extract: chat_id, text/photo/voice, sender info
  │
  ├── Find customer by telegram_id
  │   ├── Found → link message to customer
  │   └── Not found → create customer with telegram data, create lead
  │
  ├── Find or create lead
  │   ├── Existing open lead for this customer → add message to lead
  │   └── No open lead → create new lead (status: 'new')
  │
  ├── Store message in messages table
  │
  └── Trigger Realtime notification to CRM
```

## Lead Assignment

```
New lead created → check assignment rules:
1. If customer has assigned_manager → assign to that manager
2. Else: round-robin among available managers
3. If no managers available: lead stays 'new', alert generated

Unprocessed lead alert:
- If lead.status = 'new' AND age > 15 minutes → alert
- Configurable threshold
```

## Reply From CRM

```
POST /api/v1/messages/reply
{
  lead_id: "uuid",
  text: "Доброго дня! Деталь є в наявності..."
}

Server:
1. Store outbound message in messages table
2. Call Telegram API: sendMessage(chat_id, text)
3. Update lead.last_message_at
4. If lead.status = 'new' → set to 'in_progress', record response_time
```

## Manual Paste Fallback

For channels without API integration:

```
POST /api/v1/messages/manual
{
  customer_phone: "+380501234567",
  channel: "viber",
  text: "Запитує гальмівні колодки на Камрі 2015",
  direction: "inbound"
}
```

---

# SPEC: VIN OCR + FITMENT

## VIN Processing Flow

```
1. Image received (clipboard paste, file upload, or Telegram photo)
2. Pre-processing:
   - Auto-crop to VIN area (if full document photo)
   - Enhance contrast
   - Straighten/deskew
3. OCR:
   - Extract text from image
   - Pattern match: 17-character alphanumeric, excluding I, O, Q
   - Validate VIN checksum (position 9)
4. VIN Decode:
   - WMI (chars 1-3): manufacturer
   - VDS (chars 4-9): vehicle attributes
   - VIS (chars 10-17): serial number
   - API call to decode service OR local database lookup
5. Return: { make, model, year, engine, body_type }
6. Save to customer_vehicles
```

## Fitment Search Flow

```
1. Customer identified + vehicle known (from VIN or manual entry)
2. Manager searches for part type (e.g., "brake pads")
3. System queries external fitment API:
   GET /fitment?make=Toyota&model=Camry&year=2015&part_type=brake_pads
4. Returns list of OEM part numbers that fit this vehicle
5. For each OEM number, check internal catalog:
   - Exact match in products.oem_number?
   - Analog match via product_analogs?
   - Supplier availability via product_supplier_codes?
6. Display results: grouped by availability (in stock / orderable / not available)
```

## Endpoints

```
POST /api/v1/fitment/vin-decode     — Decode VIN from text or image
GET  /api/v1/fitment/search         — Search parts by vehicle + part type
POST /api/v1/fitment/ocr            — OCR image and extract VIN
```

---

# SPEC: REPORTS

## Report Endpoints

```
GET /api/v1/analytics/sales          — Sales report
GET /api/v1/analytics/payments       — Payments breakdown
GET /api/v1/analytics/debts          — Outstanding debts report
GET /api/v1/analytics/orders/stuck   — Stuck/overdue orders
GET /api/v1/analytics/inventory/low  — Low stock report
GET /api/v1/analytics/leads/unprocessed — Unprocessed leads
GET /api/v1/analytics/cash/mismatch  — Cash mismatch report
GET /api/v1/analytics/products/top   — Top products report
```

## Common Query Parameters

```
?period=today|week|month|quarter|year|custom
?date_from=2026-01-01
?date_to=2026-01-31
?cashier_id=UUID
?category_id=UUID
?format=json|csv
```

## Sales Report Fields

```
- Total revenue (gross, net)
- Number of sales
- Average sale value
- Sales by hour (for staffing decisions)
- Sales by category (which departments perform best)
- Sales by cashier (performance comparison)
- Returns count and value
- Debt sales count and value
```

## Top Products Report

```
- Best sellers by quantity
- Best sellers by revenue
- Highest margin products
- Worst sellers (candidates for clearance)
- Products with most returns (quality issues?)
```

---

# SPEC: ADMIN MODULE

## Endpoints

```
GET    /api/v1/admin/directories/:type  — Get directory entries (categories, brands, etc.)
POST   /api/v1/admin/directories/:type  — Add directory entry
PUT    /api/v1/admin/directories/:type/:id — Update entry
DELETE /api/v1/admin/directories/:type/:id — Remove entry
GET    /api/v1/admin/settings           — Get tenant settings
PUT    /api/v1/admin/settings           — Update tenant settings
GET    /api/v1/admin/integrations       — List integrations
PUT    /api/v1/admin/integrations/:key  — Update integration settings
```

## Directory Types

```
categories          — product categories tree
brands              — brand list with tiers
suppliers           — supplier directory
payment_methods     — accepted payment methods
order_statuses      — (read-only, system-defined)
return_reasons      — configurable reason codes
cancel_reasons      — order cancellation reasons
writeoff_reasons    — inventory writeoff reasons
```

## Tenant Settings

```json
{
  "store_name": "АвтоДеталі+",
  "store_address": "...",
  "store_phone": "+380...",
  "currency": "UAH",
  "tax_id": "...",
  "default_discount_percent": 0,
  "debt_sale_enabled": true,
  "debt_limit_default": 0,
  "lead_alert_threshold_minutes": 15,
  "prro_enabled": false,
  "prro_device_id": null,
  "telegram_bot_token": "***",
  "telegram_webhook_url": "...",
  "fitment_api_key": "***",
  "fitment_api_url": "..."
}
```
