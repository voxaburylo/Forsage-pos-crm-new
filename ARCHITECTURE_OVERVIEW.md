# ARCHITECTURE OVERVIEW

## System: AI-First Automotive CRM/ERP SaaS Platform

---

## 1. HIGH-LEVEL ARCHITECTURE

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                                  │
│  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────┐     │
│  │  Web CRM    │  │  Desktop Cashier │  │  Mobile Adaptive    │     │
│  │  (React)    │  │  (Electron+React)│  │  (React/PWA)        │     │
│  └──────┬──────┘  └────────┬─────────┘  └──────────┬──────────┘     │
│         │                  │                        │                │
│         └──────────────────┼────────────────────────┘                │
│                            │                                         │
│              ┌─────────────▼─────────────┐                          │
│              │   @packages/api-client    │                          │
│              │   (Shared HTTP client)    │                          │
│              └─────────────┬─────────────┘                          │
└────────────────────────────┼─────────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────┼─────────────────────────────────────────┐
│                    SERVER LAYER                                      │
│              ┌─────────────▼─────────────┐                          │
│              │   Express.js API Server   │                          │
│              │   /server                 │                          │
│              ├───────────────────────────┤                          │
│              │  Auth Middleware          │                          │
│              │  Role-Based Guards        │                          │
│              │  Input Validation         │                          │
│              │  Business Logic Services  │                          │
│              │  Error Handling           │                          │
│              └─────────────┬─────────────┘                          │
└────────────────────────────┼─────────────────────────────────────────┘
                             │ PostgreSQL Protocol
┌────────────────────────────┼─────────────────────────────────────────┐
│                    DATA LAYER (Supabase)                             │
│              ┌─────────────▼─────────────┐                          │
│              │   PostgreSQL Database     │                          │
│              │   + Row Level Security    │                          │
│              │   + Realtime Subscriptions│                          │
│              └───────────────────────────┘                          │
│              ┌───────────────────────────┐                          │
│              │   Supabase Storage        │  (photos, docs, voice)  │
│              └───────────────────────────┘                          │
│              ┌───────────────────────────┐                          │
│              │   Edge Functions          │  (Telegram bot,         │
│              │                           │   webhooks, cron jobs)  │
│              └───────────────────────────┘                          │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. MONOREPO PACKAGE STRUCTURE

```
/
├── apps/
│   ├── web/                    # React web CRM
│   │   ├── src/
│   │   │   ├── pages/          # Route-level page components
│   │   │   ├── components/     # Feature-specific components
│   │   │   ├── hooks/          # Custom React hooks
│   │   │   ├── store/          # State management (Zustand)
│   │   │   ├── utils/          # Frontend utility functions
│   │   │   └── assets/         # Static assets
│   │   ├── public/
│   │   └── package.json
│   │
│   ├── desktop/                # Electron POS cashier
│   │   ├── src/
│   │   │   ├── main/           # Electron main process
│   │   │   ├── renderer/       # Renderer (shares components with web)
│   │   │   └── preload/        # Preload scripts
│   │   └── package.json
│   │
│   └── mobile/                 # React Native / PWA
│       ├── src/
│       └── package.json
│
├── packages/
│   ├── ui/                     # Shared component library
│   │   ├── src/
│   │   │   ├── components/     # Button, Input, Table, Modal, etc.
│   │   │   ├── theme/          # Design tokens, colors, typography
│   │   │   └── index.ts        # Public API barrel export
│   │   └── package.json
│   │
│   ├── types/                  # Shared TypeScript types
│   │   ├── src/
│   │   │   ├── models/         # Entity types (Customer, Product, etc.)
│   │   │   ├── api/            # Request/Response types
│   │   │   ├── enums/          # Status enums, role enums
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── api-client/             # Shared API client
│       ├── src/
│       │   ├── client.ts       # Base HTTP client with auth
│       │   ├── endpoints/      # Per-module API methods
│       │   └── index.ts
│       └── package.json
│
├── server/                     # Express.js backend
│   ├── src/
│   │   ├── routes/             # Express route handlers
│   │   ├── services/           # Business logic layer
│   │   ├── middleware/         # Auth, validation, error handling
│   │   ├── utils/              # Server utilities
│   │   ├── jobs/               # Background jobs / cron
│   │   └── app.ts             # Express app configuration
│   ├── tests/
│   └── package.json
│
├── supabase/
│   ├── migrations/             # Sequential SQL migration files
│   ├── seeds/                  # Development seed data
│   ├── functions/              # Edge Functions (Deno)
│   ├── config.toml             # Supabase project configuration
│   └── .env.local              # Local development variables
│
├── docs/                       # AI Knowledge Base (Layer 2)
├── scripts/                    # Build, deploy, maintenance scripts
├── .github/
│   ├── workflows/              # CI/CD GitHub Actions
│   └── PULL_REQUEST_TEMPLATE.md
│
├── PROJECT_CONTEXT.md          # Layer 3: Repo-embedded context
├── CURRENT_PHASE.md
├── CURRENT_TASK.md
├── CHANGELOG_AI.md
├── DECISION_LOG.md
├── turbo.json                  # Turborepo configuration
├── package.json                # Root workspace config
└── tsconfig.base.json          # Shared TypeScript base config
```

## 3. BACKEND MODULE MAP

Each backend module follows this internal structure:

```
/server/src/routes/{module}.ts      — Express route definitions
/server/src/services/{module}.ts    — Business logic (pure functions, DB calls)
/server/src/validators/{module}.ts  — Zod input validation schemas
```

### Module List

| Module | Route Prefix | Responsibility |
|--------|-------------|----------------|
| auth | /api/v1/auth | Login, register, refresh tokens, password reset |
| users | /api/v1/users | User CRUD, role assignment |
| customers | /api/v1/customers | Customer CRUD, vehicle management, debt queries |
| products | /api/v1/products | Product CRUD, universal search, analog linking |
| inventory | /api/v1/inventory | Receipts, write-offs, stock counts, reserves |
| orders | /api/v1/orders | Order lifecycle, supplier tracking, promise timers |
| sales | /api/v1/sales | POS sale processing, returns, receipt generation |
| payments | /api/v1/payments | Payment recording, cash operations, reconciliation |
| telegram | /api/v1/telegram | Bot webhook, message routing |
| messages | /api/v1/messages | CRM message panel, lead management |
| analytics | /api/v1/analytics | Reports, aggregations, dashboards |
| admin | /api/v1/admin | Directories, settings, integrations |
| files | /api/v1/files | File upload/download, Supabase Storage proxy |
| fitment | /api/v1/fitment | VIN decode, vehicle search, OEM lookup |
| notifications | /api/v1/notifications | Internal alerts, push notifications |

## 4. DATA FLOW PATTERNS

### Sale Processing Flow

```
POS Frontend
  │
  ├─ POST /api/v1/sales
  │   Body: { customer_id?, items[], payment }
  │
  └─► Server: SalesService.createSale()
       ├─ Validate items exist and have sufficient stock
       ├─ Calculate totals (apply discounts, check min price)
       ├─ BEGIN TRANSACTION
       │   ├─ INSERT INTO sales (...)
       │   ├─ INSERT INTO sale_items (...) for each item
       │   ├─ UPDATE inventory SET qty = qty - sold_qty
       │   ├─ INSERT INTO payments (...)
       │   ├─ UPDATE customers SET debt_balance (if debt sale)
       │   └─ COMMIT
       ├─ Generate receipt data
       └─ Return { sale_id, total, receipt }
```

### Telegram Message Flow

```
Customer sends Telegram message
  │
  ├─► Telegram Webhook → Supabase Edge Function
  │    ├─ Parse message (text, photo, voice)
  │    ├─ Find or create customer by telegram_id
  │    ├─ INSERT INTO messages (...)
  │    ├─ INSERT INTO leads (...) if new conversation
  │    └─ Notify CRM via Realtime subscription
  │
  └─► CRM Web App (Realtime listener)
       ├─ New message appears in messaging panel
       ├─ Lead assigned to available manager
       ├─ Manager types reply in CRM
       │
       └─► POST /api/v1/messages/reply
            ├─ INSERT INTO messages (direction: outbound)
            └─ Call Telegram API: sendMessage to customer
```

## 5. AUTHENTICATION & AUTHORIZATION

### Auth Flow

```
Login: POST /api/v1/auth/login { phone, password }
  → Verify credentials against Supabase Auth
  → Generate JWT with { user_id, role, tenant_id }
  → Return { access_token, refresh_token }

Every request:
  → Auth middleware extracts JWT from Authorization header
  → Validates token signature and expiry
  → Attaches user context to request: req.user = { id, role, tenant_id }
  → Role guard middleware checks route permission

Supabase RLS:
  → All database queries include tenant_id filter
  → RLS policies enforce: users can only read/write their tenant's data
  → Even if API has a bug, database layer prevents cross-tenant access
```

### Role Permission Matrix

| Action | Owner | Admin | Manager | Cashier | Storekeeper | STO Viewer |
|--------|-------|-------|---------|---------|-------------|------------|
| View all reports | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage users | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Process sales | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Manage products | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Handle orders | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage inventory | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| View messages | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| View catalog | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Override min price | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cash operations | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| System settings | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

## 6. TECHNOLOGY STACK

| Layer | Technology | Version | Justification |
|-------|-----------|---------|---------------|
| Frontend Framework | React | 18+ | Industry standard, large ecosystem |
| Desktop Runtime | Electron | 28+ | Native POS capabilities, offline support |
| Mobile | React Native or PWA | Latest | Code sharing with web |
| Build Tool | Vite | 5+ | Fast HMR, modern bundling |
| Monorepo Tool | Turborepo | Latest | Build caching, task orchestration |
| UI Components | Custom + shadcn/ui patterns | N/A | Automotive-specific design needs |
| State Management | Zustand | 4+ | Simple, performant, TypeScript-native |
| Backend Runtime | Node.js | 20 LTS | Stable, async I/O, TypeScript support |
| Backend Framework | Express.js | 4.x | Mature, flexible, well-documented |
| Validation | Zod | 3+ | TypeScript-first schema validation |
| Database | PostgreSQL (Supabase) | 15+ | ACID, JSON, full-text search, RLS |
| Auth | Supabase Auth + JWT | N/A | Integrated with database RLS |
| File Storage | Supabase Storage | N/A | S3-compatible, integrated with auth |
| Edge Functions | Supabase Functions (Deno) | N/A | Webhooks, cron, async processing |
| Type System | TypeScript | 5.3+ | Strict mode, shared types |
| Testing | Vitest + Playwright | Latest | Unit + E2E |
| CI/CD | GitHub Actions | N/A | Branch protection, auto-testing |
| Package Manager | pnpm | 8+ | Workspace support, disk efficient |

## 7. MULTI-TENANCY ARCHITECTURE (Future-Ready)

All tables include a `tenant_id` column from day one, even though the initial deployment serves one tenant.

```sql
-- Every table follows this pattern:
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  -- ... other columns ...
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ  -- soft delete
);

-- RLS policy on every table:
CREATE POLICY "tenant_isolation" ON products
  USING (tenant_id = current_setting('app.tenant_id')::UUID);
```

This means:
- Adding a new tenant = inserting one row into `tenants` table
- All data is automatically isolated
- No code changes needed to support multi-tenant
- Performance scales with database, not application code

## 8. ERROR HANDLING STANDARD

```typescript
// All API errors follow this format:
{
  error: {
    code: "PRODUCT_NOT_FOUND",        // Machine-readable error code
    message: "Product with SKU X not found", // Human-readable message
    status: 404,                       // HTTP status code
    details?: { sku: "X" }            // Optional context
  }
}

// Error codes follow pattern: MODULE_ACTION_REASON
// Examples:
// AUTH_LOGIN_INVALID_CREDENTIALS
// SALE_CREATE_INSUFFICIENT_STOCK
// PAYMENT_RECORD_AMOUNT_MISMATCH
// ORDER_UPDATE_INVALID_STATUS_TRANSITION
```

## 9. API VERSIONING

All endpoints are prefixed with `/api/v1/`. When breaking changes are needed:
- New version: `/api/v2/{endpoint}`
- Old version remains active for minimum 3 months
- Deprecation warnings in response headers
- Migration guide in docs
