# Architectural & Business Decisions Registry

> Living document. Every significant technical or business decision is recorded here with rationale, alternatives considered, and reversal cost.

---

## Decision Format

```
## DEC-XXX: [Title]
- **Date:** YYYY-MM-DD
- **Status:** Accepted | Superseded | Reversed
- **Context:** Why this decision was needed
- **Decision:** What was decided
- **Alternatives Considered:** What else was on the table
- **Consequences:** What this means going forward
- **Reversal Cost:** Low | Medium | High | Irreversible
- **Owner:** Who made the call
```

---

## Founding Decisions

### DEC-001: Monorepo with Turborepo

- **Date:** 2025-01-15
- **Status:** Accepted
- **Context:** Need to share types, UI components, and API client between web, desktop, and mobile apps. Separate repos would create drift.
- **Decision:** Single monorepo using Turborepo for build orchestration.
- **Alternatives Considered:**
  - Polyrepo with npm packages — too much publish overhead for a small team.
  - Nx — heavier tooling than needed at this stage.
- **Consequences:** All code in one place. CI builds all targets. Shared `/packages/*` consumed directly.
- **Reversal Cost:** High — extracting packages into separate repos requires CI rewrite and publish pipeline.
- **Owner:** Project Architect

---

### DEC-002: Supabase as Backend-as-a-Service + Direct PostgreSQL

- **Date:** 2025-01-15
- **Status:** Accepted
- **Context:** Need managed PostgreSQL with auth, storage, edge functions, and realtime — without DevOps overhead.
- **Decision:** Supabase hosted project. All schema changes via numbered migration files. No ClickOps schema edits.
- **Alternatives Considered:**
  - Self-hosted PostgreSQL + custom auth — too much ops for solo/small team.
  - Firebase — NoSQL not suitable for relational ERP data.
  - PlanetScale — MySQL, not PostgreSQL; no built-in auth/storage.
- **Consequences:** Tied to Supabase pricing and feature roadmap. Must use their migration tooling. Get free auth, storage, realtime.
- **Reversal Cost:** Medium — can export PostgreSQL dump and move to any Postgres host; must replace auth/storage/realtime layers.
- **Owner:** Project Architect

---

### DEC-003: Money Stored as Integer Kopecks (Cents)

- **Date:** 2025-01-15
- **Status:** Accepted
- **Context:** Floating point arithmetic causes rounding errors in financial calculations. UAH has 2 decimal places (kopecks).
- **Decision:** All monetary values stored as `INTEGER` representing kopecks (1 UAH = 100 kopecks). Display layer divides by 100.
- **Alternatives Considered:**
  - `DECIMAL(12,2)` — works but adds complexity in JS where all numbers are floats.
  - Store as float with rounding — unacceptable for financial data.
- **Consequences:** Every price, payment, and balance is an integer. Frontend must format. API contracts document this clearly.
- **Reversal Cost:** Irreversible — changing representation after data exists requires migration of every financial column and recalculation.
- **Owner:** Project Architect

---

### DEC-004: Tenant ID on Every Table (Multi-Tenancy Ready)

- **Date:** 2025-01-15
- **Status:** Accepted
- **Context:** Current deployment is single-tenant, but SaaS is on the roadmap. Retrofitting tenant isolation is extremely expensive.
- **Decision:** Every business table has `tenant_id UUID NOT NULL` with Row Level Security policies enforcing isolation.
- **Alternatives Considered:**
  - Add tenant_id later when SaaS launches — migration nightmare, RLS retrofit is error-prone.
  - Schema-per-tenant — operational complexity at scale.
  - Database-per-tenant — too expensive, hard to query across tenants for analytics.
- **Consequences:** Slightly more complex queries now. RLS overhead on every query. But SaaS-ready from day one.
- **Reversal Cost:** N/A — this is a forward investment, not something to reverse.
- **Owner:** Project Architect

---

### DEC-005: Soft Delete via `deleted_at` Timestamp

- **Date:** 2025-01-15
- **Status:** Accepted
- **Context:** Automotive parts store data should never truly disappear. Audit trails, debt histories, and order references must survive deletion.
- **Decision:** All business entities use `deleted_at TIMESTAMPTZ NULL`. Active records have `deleted_at IS NULL`. All queries filter by default.
- **Alternatives Considered:**
  - Hard delete with archive table — complex, requires triggers for every table.
  - Hard delete with audit log — loses ability to restore easily.
- **Consequences:** Every SELECT must include `WHERE deleted_at IS NULL` (enforced via views or query builder). Storage grows over time.
- **Reversal Cost:** Low — can add cleanup jobs later to hard-delete old soft-deleted records.
- **Owner:** Project Architect

---

### DEC-006: Express.js Backend (Not Supabase Edge Functions Only)

- **Date:** 2025-01-15
- **Status:** Accepted
- **Context:** Complex business logic (POS, orders, payments, inventory) needs a proper server with middleware, validation, and testable service layers. Edge functions are limited to simple triggers.
- **Decision:** Express.js server in `/server` directory. Supabase Edge Functions used only for webhooks and lightweight triggers.
- **Alternatives Considered:**
  - All logic in Edge Functions — cold starts, 50MB limit, no middleware, hard to test.
  - Fastify — slightly better performance but less ecosystem/AI familiarity.
  - NestJS — too much boilerplate for AI-driven development pace.
- **Consequences:** Need to host the Express server separately (Railway, Fly.io, VPS). Supabase remains the database and auth layer.
- **Reversal Cost:** High — migrating business logic from Express to another framework requires rewriting all routes and middleware.
- **Owner:** Project Architect

---

### DEC-007: Ukrainian Language as Primary UI Language

- **Date:** 2025-01-20
- **Status:** Accepted
- **Context:** Target users are Ukrainian automotive parts retailers. UI must be in Ukrainian for adoption.
- **Decision:** All UI labels, buttons, messages, and reports in Ukrainian. i18n framework from start for future English/Russian.
- **Alternatives Considered:**
  - English-first then translate — bad UX for real users during MVP testing.
  - Hardcoded strings — technical debt that blocks future languages.
- **Consequences:** Need i18n from sprint 1. All AI-generated UI text must be reviewed for correct Ukrainian terminology.
- **Reversal Cost:** Low — i18n framework makes adding languages straightforward.
- **Owner:** Product Owner

---

### DEC-008: Telegram as Primary Messaging Channel

- **Date:** 2025-01-20
- **Status:** Accepted
- **Context:** Ukrainian automotive parts customers overwhelmingly use Telegram. Viber is secondary. No WhatsApp market.
- **Decision:** Telegram Bot API integration first. Viber as future expansion. Manual paste fallback for all other channels.
- **Alternatives Considered:**
  - Multi-channel from day one — too much integration work for MVP.
  - Viber first — smaller market share in this demographic.
- **Consequences:** Telegram bot must be production-ready for MVP. Viber architecture designed but not implemented.
- **Reversal Cost:** Low — messaging abstraction layer allows adding channels independently.
- **Owner:** Product Owner

---

## Template for New Decisions

```markdown
### DEC-XXX: [Title]

- **Date:** YYYY-MM-DD
- **Status:** Accepted
- **Context:** [Why this decision was needed]
- **Decision:** [What was decided]
- **Alternatives Considered:**
  - [Alt 1] — [why rejected]
  - [Alt 2] — [why rejected]
- **Consequences:** [What this means going forward]
- **Reversal Cost:** [Low | Medium | High | Irreversible]
- **Owner:** [Who made the call]
```

---

## Decision Index

| ID | Title | Status | Reversal Cost |
|---|---|---|---|
| DEC-001 | Monorepo with Turborepo | Accepted | High |
| DEC-002 | Supabase as BaaS | Accepted | Medium |
| DEC-003 | Money as Integer Kopecks | Accepted | Irreversible |
| DEC-004 | Tenant ID on Every Table | Accepted | N/A |
| DEC-005 | Soft Delete | Accepted | Low |
| DEC-006 | Express.js Backend | Accepted | High |
| DEC-007 | Ukrainian Primary UI | Accepted | Low |
| DEC-008 | Telegram Primary Channel | Accepted | Low |
