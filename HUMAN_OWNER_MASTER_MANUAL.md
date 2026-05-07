# HUMAN OWNER MASTER MANUAL

## AI-First Automotive CRM/ERP SaaS Platform

### Your Complete Cockpit for Building, Operating, and Scaling This System

---

**Document Version:** 1.0.0  
**Classification:** OWNER EYES ONLY — CEO Cockpit + CTO Assistant + AI Build Director Guide  
**Last Updated:** 2026-05-01  
**Maintained By:** Architecture Layer (Claude Code)

---

## TABLE OF CONTENTS

1. [What You Are Building](#1-what-you-are-building)
2. [Business System Overview](#2-business-system-overview)
3. [Module-by-Module Explanation](#3-module-by-module-explanation)
4. [MVP First Priorities](#4-mvp-first-priorities)
5. [Daily Owner Operating Workflow](#5-daily-owner-operating-workflow)
6. [Weekly Audits](#6-weekly-audits)
7. [AI Agent Usage Guide](#7-ai-agent-usage-guide)
8. [How to Feed Context to AI](#8-how-to-feed-context-to-ai)
9. [Task Chain Movement Protocol](#9-task-chain-movement-protocol)
10. [Manual QA Checklist](#10-manual-qa-checklist)
11. [Git Safety Checklist](#11-git-safety-checklist)
12. [Supabase Safety Checklist](#12-supabase-safety-checklist)
13. [Anti-Fail Decisions](#13-anti-fail-decisions)
14. [Recovery Decisions](#14-recovery-decisions)
15. [How to Interpret AI Technical Files](#15-how-to-interpret-ai-technical-files)
16. [Day-by-Day Until Stable MVP](#16-day-by-day-until-stable-mvp)

---

## 1. WHAT YOU ARE BUILDING

You are building an **AI-first autonomous automotive CRM/ERP SaaS platform**. This is not a simple website or app. This is a complete business operating system purpose-built for the automotive spare parts industry.

### In Plain Language

Imagine a single digital brain that runs your entire auto parts business:

- **Every customer** who walks in, calls, or messages you on Telegram — the system knows them, their vehicles, their debts, their order history.
- **Every part** in your warehouse — tracked by internal code, supplier article, OEM number, barcode, analog relationships, fitment to specific vehicles.
- **Every sale** — whether at the cash register, through an order, or a debt transaction — recorded, analyzed, reportable.
- **Every supplier** — rated by speed, reliability, price, with automatic ordering suggestions.
- **Every message** — Telegram leads captured, assigned to managers, replied to from within the CRM.
- **Every payment** — cash, card, bank transfer, split payments, debts, prepayments — all reconciled.

### What Makes This Different From Existing Software

1. **Automotive Intelligence**: Built from the ground up for auto parts. VIN decoding, OEM fitment trees, analog search, brand priority tiers — not bolted on as an afterthought.
2. **AI-First Development**: The entire system is being built using AI agents as the primary development workforce, with you as the strategic director.
3. **SaaS-Ready Architecture**: From day one, the code supports multi-tenant deployment. You start with one store. The architecture supports hundreds.
4. **Ukrainian Market Fit**: PRRO fiscal integration readiness, Telegram/Viber messaging, Ukrainian payment flows, local supplier workflows.
5. **Offline-Resilient POS**: The cashier keeps working when internet drops. Sync when restored.

### The End Game

**Phase 1 (Now):** Run YOUR store better than any competitor.  
**Phase 2 (6 months):** Add features that make managers beg to keep using it.  
**Phase 3 (12 months):** Package it as SaaS and sell to other auto parts stores.  
**Phase 4 (18+ months):** Build the platform that dominates the Ukrainian/CIS auto parts market.

---

## 2. BUSINESS SYSTEM OVERVIEW

### Platform Architecture

The system runs on three client surfaces powered by one unified backend:

| Platform | Purpose | Primary Users |
|----------|---------|---------------|
| **Web CRM** | Full management dashboard | Owner, Admin, Manager |
| **Desktop Cashier** | Point-of-sale terminal | Cashier |
| **Mobile Adaptive** | On-the-go management | Manager, Storekeeper |

All three platforms connect to:

- **Unified Backend Server** — Node.js/Express API handling all business logic
- **Supabase PostgreSQL** — The single source of truth for all data
- **Supabase Storage** — Photos, documents, attachments
- **Supabase Edge Functions** — Webhook handlers, Telegram bot, async jobs

### Data Flow Summary

```
Customer walks in / sends Telegram message / calls
    ↓
Lead captured → assigned to manager → converted to order or sale
    ↓
Products searched by barcode/OEM/VIN → stock checked → analogs suggested
    ↓
Sale processed at POS / Order placed with supplier
    ↓
Payment recorded → inventory updated → customer profile enriched
    ↓
Reports generated → debts tracked → analytics delivered
```

### Monorepo Structure

All code lives in a single Git repository:

```
/apps/web          — React web CRM application
/apps/desktop      — Electron-based POS cashier terminal
/apps/mobile       — React Native / PWA mobile manager app
/packages/ui       — Shared component library (buttons, forms, tables)
/packages/types    — Shared TypeScript type definitions
/packages/api-client — Shared API client for all frontends
/server            — Express.js backend API
/supabase          — Migrations, seeds, edge functions, storage config
/docs              — AI knowledge base (you are reading part of this now)
/scripts           — Build, deploy, maintenance, seed scripts
/.github           — CI/CD workflows, PR templates, issue templates
```

---

## 3. MODULE-BY-MODULE EXPLANATION

### 3.1 AUTH & ROLES

**What it does:** Controls who can access what in the system.

**Roles explained:**

| Role | What They Can Do | What They Cannot Do |
|------|-----------------|-------------------|
| **Owner** | Everything. See all data, all stores, all reports, all settings. | N/A — full access |
| **Admin** | Manage users, products, settings. View reports. Almost everything Owner can. | Cannot delete the system, change billing, or remove Owner. |
| **Manager** | Handle customers, orders, messages. View relevant reports. | Cannot manage users, change system settings, or see financial internals. |
| **Cashier** | Process sales, returns, cash operations. | Cannot manage products, view reports, or handle orders outside POS. |
| **Storekeeper** | Manage inventory: receipts, writeoffs, stock counts. | Cannot process sales, manage customers, or view financial reports. |
| **STO Viewer** | Read-only access to parts catalog and fitment for partner repair shops. | Cannot modify anything. View only. |

**Why it matters to you:** Start with Owner + Cashier. Add roles as you hire. The system enforces that your cashier cannot discount below minimum price without your approval.

### 3.2 CUSTOMERS (CRM)

**What it does:** Complete customer lifecycle management.

**Key capabilities:**

- **Customer Card**: Name, phone(s), email, vehicles (with VINs), notes, tags
- **Debt Tracking**: Every sale on credit is tracked. Outstanding balances visible per customer. Aging reports available.
- **Bonus System**: Point accumulation, discount tiers, loyalty rewards
- **Vehicle Registry**: Each customer's vehicles stored with make/model/year/VIN. When they call, you know what they drive.
- **Communication History**: Every Telegram message, every order, every sale, every payment — visible on one timeline.
- **Quick Create**: Cashier can create a customer in 5 seconds during a sale (phone + name, done).

**Why it matters to you:** You will never lose a customer's history. When someone calls asking "what brake pads did you sell me last year for my Camry?", you will know in 3 seconds.

### 3.3 PRODUCTS

**What it does:** Master catalog for everything you sell.

**How auto parts identification works in this system:**

Every part has multiple identifiers, and the system handles all of them:

- **Internal SKU**: Your store's own code (e.g., `BRK-00421`)
- **Supplier Article**: The code your supplier uses (e.g., `TRW-GDB1550`)
- **OEM Number**: The original manufacturer's number (e.g., `04465-33471`)
- **Barcodes**: One or multiple (EAN, custom, supplier barcode)
- **Aliases**: Informal names staff use ("Camry front pads")

**Analog System**: When a customer needs part X, the system shows:

| Priority | Type | Example |
|----------|------|---------|
| 1 | Original (OEM) | Toyota Genuine 04465-33471 |
| 2 | Premium Aftermarket | TRW, Bosch, Brembo |
| 3 | Standard Aftermarket | Remsa, Ferodo |
| 4 | Budget | Local/Chinese brands |

**Pricing layers:**

- **Purchase Price**: What you pay the supplier
- **Retail Price**: What a walk-in customer pays
- **Wholesale Price**: What a B2B customer pays
- **Minimum Price**: The absolute floor — system blocks sales below this
- **Historical Prices**: Every price change recorded with date and reason

**Special product flags:**

- *Weight-based*: Sold by kg (fasteners, wire)
- *Quick Cash*: Generic items sold without tracking (washers, nuts)
- *Order Only*: Not in stock, only orderable from supplier
- *Decimal Qty*: Allows 0.5, 1.25 units (for meters, liters, kg)

**Why it matters to you:** No more "I think we have that somewhere." Universal search across all codes means the cashier finds the part no matter how the customer describes it.

### 3.4 INVENTORY

**What it does:** Tracks every physical item in your warehouse.

**Key operations:**

- **Receipts**: Supplier deliveries recorded with invoice number, quantities, prices
- **Supplier Invoices**: Scanned/uploaded, linked to receipt records
- **Write-offs**: Damaged, expired, lost items removed from stock with reason codes
- **Inventory Sessions**: Full or partial stock counts with variance reporting
- **Reserves**: Items held for specific orders/customers
- **Supplier Returns**: Defective items sent back, tracked until credit received
- **Low Stock Alerts**: Automatic notifications when items fall below reorder point
- **Dead Stock Detection**: Items sitting longer than X days flagged for review

**Warehouse Locations (Future):** Placeholder fields for shelf/bin locations, supporting multi-warehouse when you expand.

**Why it matters to you:** You will know exactly what you have, what you need to order, and what is sitting dead on shelves costing you money.

### 3.5 POS (Point of Sale)

**What it does:** The cashier's primary workspace for processing sales.

**Critical cashier features:**

- **Barcode Scanning**: Scan → item appears → add to receipt
- **Global Search**: Type any code, name, or alias → results appear instantly
- **Multiple Open Checks**: Work on several receipts simultaneously (customer A is looking for another part while customer B is ready to pay)
- **Suspended Receipts**: Park a receipt, serve another customer, resume later
- **Favorite Items**: One-tap buttons for high-frequency items (oil, filters)
- **Split Payments**: Half cash, half card. Or any combination.
- **Cash In/Out**: Record cash drawer operations (float, withdrawal)
- **Returns**: Process returns with reason codes, auto-adjust inventory
- **Debt Sales**: Sell on credit to approved customers, auto-update debt balance
- **Quick Customer Create**: Phone + name → customer created during checkout
- **Discount Presets**: 5%, 10%, 15% buttons. Cannot go below minimum price.
- **Min Price Lock**: System refuses to process sale below minimum price without override code
- **Change Calculator**: Auto-calculates change for cash payments
- **Quick Last Sales**: "Sell the same as last time" — one tap repeat sale
- **Duplicate Sale Warning**: Alert if identical sale processed within 5 minutes
- **Hotkeys**: Keyboard shortcuts for every major action
- **PRRO Status Indicator**: Visual banner showing fiscal receipt printer status
- **Internet Status Banner**: Clear indicator when connection is lost
- **Shift Close**: End-of-day cash count, report generation, shift handoff

**Why it matters to you:** Your cashier processes sales in seconds, not minutes. No training manual needed — the interface is obvious. And the system catches mistakes before they happen.

### 3.6 ORDERS

**What it does:** Manages customer orders for parts not in stock.

**Order lifecycle:**

```
Draft → Quoted → Prepaid → Ordered from Supplier → Arrived → Issued to Customer → Closed
         ↓                                                          ↓
      Cancelled                                                  Lost Order
```

**Key capabilities:**

- **Manual Draft**: Manager creates order from customer request
- **Message Draft**: Order created directly from Telegram conversation
- **Attachments**: Photos, VIN images, voice messages attached to order
- **Unknown Item Request**: Customer describes a part they cannot identify → order created with description, manager researches later
- **OEM/Analog Selection**: Pick the right part variant for the customer's vehicle
- **Supplier Selection**: Choose supplier based on price, speed, availability
- **Quoted Price**: Customer sees price before committing
- **Prepayment Tracking**: Record partial or full prepayment
- **Arrival Notification**: System flags when ordered part arrives
- **Promise Timers**: "Promised by Friday" — system tracks and alerts on overdue promises
- **Lost Order Analytics**: When orders are cancelled, reason codes captured and analyzed
- **Cancel Reasons**: Price too high, found elsewhere, wrong part, customer changed mind, etc.

**Why it matters to you:** Orders do not get lost in notebooks. Every promise is tracked. Every lost sale is analyzed so you can improve.

### 3.7 PAYMENTS LEDGER

**What it does:** Records every monetary transaction in and out of the business.

**Payment types supported:**

| Type | Description |
|------|-------------|
| Cash | Physical cash at register |
| Terminal | Card payment via POS terminal |
| Bank Card Transfer | Direct card-to-card transfer (common in UA market) |
| Split | Any combination of the above |
| Debt Repayment | Customer paying off existing debt |
| Partial Payment | Customer pays portion of total |
| Prepayment | Customer pays in advance for an order |
| Cash Service | Non-sale cash operations (change, deposit) |
| Bank Transfer Screenshot | B2B payment confirmed via screenshot upload |

**Why it matters to you:** Perfect cash reconciliation at shift close. No more "the register is short and we don't know why."

### 3.8 MESSAGING (Telegram + Viber Architecture)

**What it does:** Captures incoming customer messages and enables response from CRM.

**How it works:**

1. Customer sends message to your Telegram bot
2. Message appears in CRM messaging panel
3. System creates a lead record if customer is new
4. Lead assigned to available manager
5. Manager responds from CRM (reply goes back to customer's Telegram)
6. Full conversation visible on customer timeline
7. Unprocessed leads generate alerts after X minutes

**Viber Architecture**: Planned but not built yet. Architecture ready, just needs API integration.

**Manual Paste Fallback**: For channels without API integration, manager can paste message content manually into CRM with customer phone number. System still creates the lead and tracks the conversation.

**Why it matters to you:** You never miss a lead. Every customer message is tracked. Response times are measurable. Managers are accountable.

### 3.9 VIN OCR + FITMENT

**What it does:** Decodes vehicle identification from VIN photos and finds compatible parts.

**Workflow:**

1. Customer sends photo of VIN plate (or registration document)
2. Manager pastes image into CRM
3. System crops VIN area → runs OCR → extracts 17-character VIN
4. VIN decoded to: Make, Model, Year, Engine, Body type
5. Vehicle information saved to customer card
6. Manager searches for parts → system filters by vehicle fitment
7. OEM part numbers for that vehicle displayed
8. Internal stock checked → analogs suggested → supplier availability shown

**External Fitment API**: System integrates with third-party fitment databases (TecDoc, equivalent). OEM candidates returned, then cross-referenced with your internal catalog.

**Why it matters to you:** Customer shows VIN → you instantly know the car and which parts fit. No guessing. No returns due to wrong fitment. Faster service than any competitor.

### 3.10 REPORTS

**What it does:** Business intelligence dashboards and exportable reports.

**Available reports:**

| Report | What It Shows | Who Needs It |
|--------|--------------|--------------|
| Sales Report | Revenue by period, by cashier, by product | Owner, Admin |
| Payments Report | Cash vs card vs transfer breakdown | Owner |
| Debts Report | Outstanding customer debts, aging, top debtors | Owner, Admin |
| Stuck Orders | Orders past promised date, unprocessed orders | Manager, Owner |
| Low Stock | Items below reorder point | Storekeeper, Owner |
| Unprocessed Leads | Messages without response beyond threshold | Manager, Owner |
| Cash Mismatch | Register count vs system count variance | Owner |
| Top Products | Best sellers, best margin, worst sellers | Owner |

**Why it matters to you:** You make decisions based on data, not gut feeling. You see problems before they become crises.

### 3.11 ADMIN MODULE

**What it does:** System configuration and directory management.

**Key areas:**

- **Directories**: Product categories, brands, supplier list, payment types, order statuses, return reasons, etc.
- **Integrations**: API keys for Telegram bot, fitment API, future payment gateways
- **Users**: Create/edit/deactivate user accounts
- **Roles**: Assign permissions (pre-defined role templates)
- **Branch Placeholders**: Data structures ready for multi-store expansion (hidden in UI until activated)

---

## 4. MVP FIRST PRIORITIES

### What Gets Built First (And Why)

The MVP is the minimum system that replaces your current paper/spreadsheet workflow. It must be reliable enough that you trust it for daily operations.

### MVP Priority Matrix

| Priority | Module | Reason |
|----------|--------|--------|
| **P0 — Foundation** | Auth + Database Schema + API Skeleton | Nothing works without this |
| **P1 — Core Sales** | Products + Inventory (basic) + POS (basic) | This is the daily heartbeat of the store |
| **P2 — Customer** | Customer CRM (basic) + Debt Tracking | You need to know who is buying and who owes you |
| **P3 — Orders** | Order lifecycle (basic flow) | Handles the 40%+ of business that is not walk-in |
| **P4 — Payments** | Payment ledger + Cash reconciliation | Financial accuracy |
| **P5 — Messaging** | Telegram intake + Lead board | Capture incoming leads |
| **P6 — Reports** | Sales + Debts + Low Stock | Owner visibility |

### What Is NOT In MVP

- VIN OCR (manual VIN entry is MVP fallback)
- External Fitment API integration
- Viber integration
- Multi-store / multi-warehouse
- SaaS tenant management
- Bonus/loyalty system
- Advanced analytics
- Mobile app (use responsive web)

### MVP Definition of Done

You can say "MVP is done" when:

1. A cashier can scan a barcode, find a product, process a sale, and take payment
2. Inventory updates automatically after each sale
3. Customer records exist with purchase history and debt tracking
4. Orders can be created, tracked through lifecycle, and closed
5. Telegram messages appear in CRM and can be replied to
6. End-of-day cash reconciliation works
7. Owner can see sales, debts, and low stock reports
8. System runs for a full business day without crashing

---

## 5. DAILY OWNER OPERATING WORKFLOW

### Morning Routine (15 minutes)

```
08:00 — Open the project GitHub board
         → Check: Are there any failed CI/CD builds? (Red badges)
         → Check: Any open Pull Requests waiting for merge?
         → Check: What tasks are "In Progress"?

08:05 — Open Supabase Dashboard
         → Check: Database is online
         → Check: No error spikes in logs
         → Check: Storage usage is normal

08:10 — Review CURRENT_TASK.md in the repository
         → What was the last completed task?
         → What is the next task in the chain?
         → Are there any blocked tasks?

08:15 — Decide: What gets built today?
         → Update CURRENT_TASK.md with today's target
         → Open the right AI agent and feed it context
```

### During-Day Protocol

```
Every 2-3 hours:
  → Check the AI agent's output
  → Review generated code (does it look reasonable?)
  → Run the QA checklist for completed features
  → Merge approved PRs to main branch
  → Update GitHub board task status
  → Note any problems in DECISION_LOG.md

When a task is completed:
  → Run the task close QA checklist
  → Merge to main
  → Create a Git tag if it is a milestone
  → Update CURRENT_TASK.md
  → Update CHANGELOG_AI.md
  → Move to the next task
```

### Evening Routine (10 minutes)

```
End of work:
  → Ensure main branch is stable (all tests pass)
  → Push any local changes
  → Write a 2-line summary of what was accomplished today
  → Update CURRENT_PHASE.md if the phase changed
  → Back up Supabase if any schema changes were made
  → Close AI agent sessions (do not leave them idle with stale context)
```

---

## 6. WEEKLY AUDITS

### Every Monday — Architecture Audit (30 min)

1. Open `/docs/architecture/` and compare current codebase state to documented architecture
2. Check: Are any modules deviating from the planned structure?
3. Check: Are any database tables missing indexes for common queries?
4. Check: Is the API response time acceptable? (Load Supabase dashboard → check query performance)
5. Check: Are there any TODO/FIXME comments older than 2 weeks?
6. Document findings in `/docs/audits/AUDIT_YYYY_WXX.md`

### Every Wednesday — Data Integrity Audit (20 min)

1. Run the database integrity check script (`/scripts/audit-data.sql`)
2. Check: Any orphaned records? (orders with no customer, payments with no sale)
3. Check: Any duplicate products? (same OEM number, different SKUs)
4. Check: Any negative inventory balances?
5. Check: Any customers with impossible debt amounts?
6. Document findings in audit file

### Every Friday — Security + Access Audit (15 min)

1. Check Supabase auth logs: Any failed login spikes?
2. Check Row Level Security policies: Still enforced?
3. Check API keys: Any exposed in code? (Run `grep -r "key" --include="*.ts"`)
4. Check: Are all environment variables in `.env` and NOT in committed code?
5. Check: Is the production database backup from this week verified?

---

## 7. AI AGENT USAGE GUIDE

### Which AI Agent For Which Task

| Task Type | Primary Agent | Why |
|-----------|--------------|-----|
| **Architecture decisions** | Claude Code | Best at system-level thinking, module boundaries, data modeling |
| **Building features** (backend + frontend) | DeepSeek | Fast code generation, good at following specs |
| **Repository operations** (file creation, refactoring, large edits) | Cursor | Integrated into IDE, best for multi-file operations |
| **Code review + logic analysis** | Gemini | Good at finding logical errors, edge cases, contradictions |
| **Database schema design** | Claude Code | Understands relational modeling deeply |
| **UI/UX design decisions** | Claude Code or Gemini | Can reason about user flows |
| **Bug diagnosis** | Gemini or Claude Code | Good at reading stack traces, understanding error chains |
| **Documentation** | Claude Code | Maintains consistency, understands project structure |
| **Prompt engineering** | Claude Code | Can write prompts for DeepSeek/Cursor to consume |

### Agent Workflow Pattern

```
Step 1: CLAUDE CODE creates the spec and prompt for a feature
Step 2: DEEPSEEK / CURSOR builds the code following the spec
Step 3: GEMINI reviews the code for logic errors
Step 4: YOU run the QA checklist
Step 5: Merge to main
```

### Critical Rules for AI Agents

1. **Never give an AI agent access to production database credentials.** Development only.
2. **Never let an AI agent push directly to main branch.** Always feature branch → PR → review → merge.
3. **Always feed the current PROJECT_CONTEXT.md** at the start of a new AI session.
4. **Always feed the relevant module spec** before asking an AI to build a feature.
5. **Never trust AI-generated SQL on production** without reading it yourself first.
6. **If an AI suggests deleting a table or column**, STOP. Review with extreme care. Data loss is permanent.
7. **Keep AI sessions focused.** One task per session. New task → new session with fresh context.

---

## 8. HOW TO FEED CONTEXT TO AI

### The Context Sandwich Method

Every time you start a new AI session for a task, provide context in this order:

```
Layer 1: PROJECT_CONTEXT.md (full project overview)
Layer 2: Relevant module spec from /docs/specs/
Layer 3: CURRENT_TASK.md (what exactly needs to be done)
Layer 4: Any relevant existing code files
Layer 5: The specific prompt from /docs/prompts/
```

### Example: Building the POS Barcode Search Feature

```
Paste to AI:
1. PROJECT_CONTEXT.md (so AI knows the whole system)
2. /docs/specs/SPEC_POS.md (so AI knows POS requirements)
3. /docs/specs/SPEC_PRODUCTS.md (so AI knows product data model)
4. CURRENT_TASK.md → "TASK-045: Implement barcode search in POS"
5. /docs/tasks/TASK-045.md (detailed task spec)
6. /docs/prompts/PROMPT_FULLSTACK_FEATURE.md (template prompt)
7. Relevant existing code: /server/src/routes/products.ts, /apps/web/src/components/POS/
```

### Context Size Management

- If context is too large for the AI, prioritize: Task spec > Module spec > Architecture overview > Project context
- Use the `/docs/prompts/` templates — they are designed to work with constrained context windows
- For large refactors, break into smaller tasks and feed context incrementally

---

## 9. TASK CHAIN MOVEMENT PROTOCOL

### Task Lifecycle

```
BACKLOG → READY → IN PROGRESS → CODE REVIEW → QA → DONE → MERGED
```

### Moving a Task Forward

**BACKLOG → READY**: Task spec exists in `/docs/tasks/TASK-XXX.md`. All dependencies identified. No blockers.

**READY → IN PROGRESS**: You have assigned it to an AI agent session. Context has been fed. Work has begun.

**IN PROGRESS → CODE REVIEW**: Code is written. Feature branch pushed. PR created. AI (Gemini) reviews OR you review.

**CODE REVIEW → QA**: Code review passed. Run the QA checklist from `/docs/qa/QA_CHECKLIST.md`.

**QA → DONE**: All QA items pass. PR approved.

**DONE → MERGED**: PR merged to main. CURRENT_TASK.md updated. CHANGELOG_AI.md updated. GitHub board updated.

### Task Dependencies

Some tasks cannot start until others are done. The task files document this:

```
TASK-045:
  depends_on: [TASK-012, TASK-030]
  blocks: [TASK-046, TASK-047]
```

Never start a task whose dependencies are not MERGED.

---

## 10. MANUAL QA CHECKLIST

After every completed feature, run through this checklist:

### Functionality QA

- [ ] Does the feature do what the spec says?
- [ ] Does it handle empty states? (no data, no results)
- [ ] Does it handle error states? (network down, invalid input)
- [ ] Does it handle edge cases? (maximum length inputs, special characters, Ukrainian characters)
- [ ] Does it work with the existing data? (not just fresh/seed data)
- [ ] Does it work across all target platforms? (web, desktop, mobile)

### Data QA

- [ ] Does it create the correct database records?
- [ ] Does it update related records correctly? (e.g., sale updates inventory)
- [ ] Does it respect data isolation? (user can only see their own data, roles enforced)
- [ ] Are there any orphaned records possible?
- [ ] Is there proper cascade behavior on delete?

### UI QA

- [ ] Is the interface usable without reading documentation?
- [ ] Do buttons and labels make sense in Ukrainian?
- [ ] Does it work on 1920x1080 screen? (desktop)
- [ ] Does it work on 1366x768 screen? (common laptop)
- [ ] Does it work on mobile viewport? (if applicable)
- [ ] Are loading states shown during async operations?
- [ ] Are error messages user-readable? (not technical stack traces)

### Security QA

- [ ] Are API endpoints protected by auth middleware?
- [ ] Are Row Level Security policies active on the affected tables?
- [ ] Is input validated on both frontend and backend?
- [ ] Are SQL queries parameterized? (no string concatenation with user input)
- [ ] Are sensitive fields (passwords, API keys) never returned in API responses?

### Performance QA

- [ ] Does the feature load in under 2 seconds?
- [ ] Are database queries using indexes?
- [ ] Are list views paginated? (no loading 10,000 records at once)
- [ ] Are images optimized before storage?

---

## 11. GIT SAFETY CHECKLIST

### Branch Strategy

```
main          — Always stable. Always deployable. Never commit directly.
develop       — Integration branch. Features merge here first.
feature/XXX   — One branch per task (e.g., feature/TASK-045-pos-barcode)
hotfix/XXX    — Emergency fixes that go directly to main after review
```

### Before Every Merge to Main

- [ ] All tests pass
- [ ] PR has been reviewed (by AI or by you)
- [ ] No merge conflicts
- [ ] CHANGELOG_AI.md updated
- [ ] No `.env` files or secrets in the diff
- [ ] No `console.log` debugging statements left in code
- [ ] Database migrations are reversible (have a down migration)
- [ ] Feature branch is up to date with develop/main

### Git Emergency Protocol

**If you accidentally push secrets to GitHub:**
1. Immediately revoke the exposed key/password
2. Generate new credentials
3. Use `git filter-branch` or BFG Repo-Cleaner to remove from history
4. Force push the cleaned history
5. Document in DECISION_LOG.md

**If main branch is broken:**
1. Do NOT panic
2. `git log --oneline -10` — find the last good commit
3. `git revert <bad-commit>` — create a revert commit (preserves history)
4. Push the revert to main
5. Fix the issue on a branch
6. Document what happened

---

## 12. SUPABASE SAFETY CHECKLIST

### Database Operations Safety

- [ ] **Never** run `DROP TABLE` or `DROP COLUMN` on production without a backup
- [ ] **Always** test migrations on local Supabase first
- [ ] **Always** have a rollback migration ready before applying to production
- [ ] **Never** disable Row Level Security, even temporarily
- [ ] **Always** use migrations for schema changes (never use the Supabase UI to alter tables in production)
- [ ] **Weekly** download a full database backup

### Migration Protocol

```
Step 1: Write migration SQL in /supabase/migrations/
Step 2: Test locally: supabase db reset
Step 3: Test on staging (if available)
Step 4: Backup production database
Step 5: Apply to production: supabase db push
Step 6: Verify — check that all tables, columns, indexes exist
Step 7: Commit migration file to Git
```

### Backup Protocol

```
Weekly:
  → Supabase Dashboard → Database → Backups → Download latest
  → Store in secure location (NOT in the Git repo)
  → Verify backup by restoring to a test instance quarterly

Before any schema change:
  → Manual backup before migration
  → Keep backup until migration is verified stable (minimum 1 week)
```

---

## 13. ANTI-FAIL DECISIONS

These are decisions made in advance to prevent the most common project failures.

### Anti-Fail #1: Never Skip the Spec

**Rule:** No code is written without a task spec in `/docs/tasks/`.  
**Why:** AI agents produce garbage when given vague instructions. The spec is the contract.

### Anti-Fail #2: Never Build Two Things at Once

**Rule:** One task in progress at a time. Finish it, merge it, move on.  
**Why:** Parallel feature branches create merge conflicts that can take days to resolve.

### Anti-Fail #3: Never Trust AI Output Without QA

**Rule:** Every AI-generated feature runs through the QA checklist before merge.  
**Why:** AI makes confident-sounding mistakes. It will write code that compiles but silently loses data.

### Anti-Fail #4: Never Modify Production Data Directly

**Rule:** All database changes go through migrations. No manual SQL on production.  
**Why:** Manual changes cannot be reproduced, tracked, or rolled back.

### Anti-Fail #5: Never Lose the Schema

**Rule:** Database schema is fully documented in `/docs/specs/SPEC_DATABASE.md` and always matches the actual migrations.  
**Why:** If you lose track of your schema, you lose the ability to understand your own system.

### Anti-Fail #6: Never Deploy on Friday

**Rule:** No production deployments after Wednesday unless it is a critical hotfix.  
**Why:** If something breaks, you want business days to fix it.

### Anti-Fail #7: Always Keep Main Deployable

**Rule:** The `main` branch must always be in a state where it can be deployed and work.  
**Why:** If main is broken, nobody can work. It is the foundation.

### Anti-Fail #8: Never Delete Data, Soft-Delete Instead

**Rule:** All `DELETE` operations are soft-deletes (set `deleted_at` timestamp). Actual removal only in maintenance windows after verification.  
**Why:** Deleted data cannot be recovered. Soft-deleted data can be restored in seconds.

### Anti-Fail #9: Always Use TypeScript Strict Mode

**Rule:** `strict: true` in `tsconfig.json` across all packages.  
**Why:** Loose type checking allows bugs that only appear in production.

### Anti-Fail #10: Never Store Money as Float

**Rule:** All monetary values stored as integers (kopecks/cents). Display formatting only at the UI layer.  
**Why:** Floating point arithmetic creates rounding errors. 0.1 + 0.2 ≠ 0.3 in computers.

---

## 14. RECOVERY DECISIONS

### Scenario: Database is Corrupted or Lost

1. Take the application offline immediately
2. Restore from the most recent weekly backup
3. Check CHANGELOG_AI.md for any schema changes since the backup
4. Re-apply missing migrations
5. Notify all users that data between backup and corruption event may be lost
6. Document the incident, root cause, and prevention measures
7. Increase backup frequency

### Scenario: AI Agent Broke the Codebase

1. Stop all AI agent sessions
2. Check Git log: `git log --oneline -20`
3. Identify which commits introduced the breakage
4. If it is on a feature branch: delete the branch, start the task over
5. If it was merged to main: `git revert` the bad commits
6. Review what went wrong in the context/prompt that caused the bad output
7. Update the relevant task spec to prevent recurrence

### Scenario: Supabase is Down

1. Check Supabase status page: https://status.supabase.com
2. If it is a Supabase-side outage: wait (not within your control)
3. If it is your project: check Supabase dashboard for error logs
4. If database connection limit exceeded: restart the application
5. If storage is full: upgrade plan or clean up unused files
6. Document in DECISION_LOG.md

### Scenario: Customer Data Breach Suspected

1. Immediately revoke all API keys and rotate Supabase credentials
2. Check auth logs for unauthorized access
3. Determine scope: what data was potentially accessed?
4. If confirmed: notify affected customers (required by law in many jurisdictions)
5. Fix the vulnerability
6. Engage security professional if needed
7. Document everything

### Scenario: Lost Track of What is Built vs. What is Not

1. Stop all development
2. Open CURRENT_PHASE.md and CURRENT_TASK.md
3. Walk through the task chain from TASK-001, marking each as: DONE / IN PROGRESS / NOT STARTED
4. Compare with actual codebase: does the code match the DONE tasks?
5. Update all status files
6. Resume from the correct position

---

## 15. HOW TO INTERPRET AI TECHNICAL FILES

### Reading Database Specs

When you see a database table definition like:

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  debt_balance INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Translation:
- **UUID PRIMARY KEY**: Every customer gets a unique ID (a long random string)
- **VARCHAR(20) NOT NULL UNIQUE**: Phone number, max 20 characters, cannot be empty, no duplicates
- **INTEGER DEFAULT 0**: Debt balance starts at zero, stored as integer (kopecks)
- **TIMESTAMPTZ**: Timestamp with timezone — when the record was created

### Reading API Specs

When you see:

```
POST /api/v1/sales
Authorization: Bearer <token>
Body: { customer_id, items: [...], payment_method }
Returns: 201 Created { sale_id, total, receipt_url }
```

Translation:
- **POST**: This creates a new thing (a sale)
- **/api/v1/sales**: The address where this action lives
- **Authorization: Bearer**: Requires a logged-in user
- **Body**: What data you send (customer, items, how they pay)
- **Returns 201**: Success! Here is the sale ID, total, and receipt link

### Reading Task Specs

Task specs follow a standard format:

```
TASK-045: POS Barcode Search
Module: POS
Priority: P1
Depends: TASK-012, TASK-030
Description: [what to build]
Acceptance Criteria: [how to know it is done]
Technical Notes: [implementation guidance for AI]
```

You need to read: Description and Acceptance Criteria.
The Technical Notes are for the AI agent.

### Reading Architecture Diagrams

Arrows mean data flow:
```
Customer → API → Database → API → Frontend
```
Translation: Customer does something → request goes to the server → server reads/writes the database → server sends response → screen updates.

Boxes mean components:
```
[Frontend] → [API Gateway] → [Business Logic] → [Database]
```
Translation: Each box is a layer of the system. Data flows left to right, or top to bottom.

---

## 16. DAY-BY-DAY UNTIL STABLE MVP

### Week 1: Foundation

| Day | What To Do |
|-----|-----------|
| Mon | Set up monorepo structure. Initialize all packages. Configure TypeScript. Configure ESLint. |
| Tue | Design and review complete database schema (all MVP tables). Write it in SPEC_DATABASE.md. |
| Wed | Create Supabase project. Write and apply initial migration. Set up Row Level Security. |
| Thu | Build auth module: registration, login, JWT tokens, role assignment. |
| Fri | Build basic API skeleton: health check, auth middleware, error handling, logging. |

### Week 2: Products + Inventory Core

| Day | What To Do |
|-----|-----------|
| Mon | Build products CRUD API. Internal SKU, supplier article, OEM, barcode fields. |
| Tue | Build products search API: universal search across all identifiers. |
| Wed | Build inventory receipts: record incoming stock from suppliers. |
| Thu | Build inventory adjustments: write-offs, corrections. |
| Fri | Build basic product UI: list view, detail view, search bar. QA all week's work. |

### Week 3: POS Core

| Day | What To Do |
|-----|-----------|
| Mon | Build POS layout: receipt panel, product search, payment section. |
| Tue | Build barcode scan → product lookup → add to receipt flow. |
| Wed | Build payment processing: cash, card. Calculate totals and change. |
| Thu | Build receipt finalization: save sale, update inventory, print receipt data. |
| Fri | Build suspended receipts and multiple open checks. QA all POS functionality. |

### Week 4: Customers + Orders Core

| Day | What To Do |
|-----|-----------|
| Mon | Build customer CRUD: create, search, view profile. Quick-create from POS. |
| Tue | Build customer debt tracking: sell on credit, view balance, record repayment. |
| Wed | Build order creation: manual draft, add items, select supplier. |
| Thu | Build order lifecycle: status transitions, arrival, issuance, cancellation. |
| Fri | Link orders to customers. Customer timeline showing sales + orders. QA everything. |

### Week 5: Payments + Messaging

| Day | What To Do |
|-----|-----------|
| Mon | Build payment ledger: record all payment types, link to sales/orders. |
| Tue | Build cash reconciliation: shift open/close, cash count, mismatch detection. |
| Wed | Set up Telegram bot. Build message intake: receive messages, create leads. |
| Thu | Build CRM message panel: view leads, assign to manager, reply. |
| Fri | Build unprocessed lead alerts. QA messaging flow end-to-end. |

### Week 6: Reports + Polish + Stabilize

| Day | What To Do |
|-----|-----------|
| Mon | Build sales report: revenue by day/week/month, by cashier. |
| Tue | Build debts report and low stock report. |
| Wed | Full system walkthrough: simulate a complete business day (open shift → serve customers → process orders → close shift). |
| Thu | Fix all bugs found during walkthrough. Polish UI. |
| Fri | **MVP CHECKPOINT**: Complete QA audit. Tag release v0.1.0. Celebrate. |

### Post-MVP

After Week 6, switch to a weekly cycle:
- Monday: Plan the week's tasks from the task chain
- Tuesday-Thursday: Build
- Friday: QA + merge + stabilize

---

## APPENDIX A: KEY TERMS GLOSSARY

| Term | Meaning |
|------|---------|
| **OEM** | Original Equipment Manufacturer — the company that made the car's original part |
| **SKU** | Stock Keeping Unit — your internal product code |
| **VIN** | Vehicle Identification Number — 17-character unique vehicle ID |
| **Fitment** | Which parts are compatible with which vehicles |
| **Analog** | A part from a different brand that fits the same vehicle as the original |
| **PRRO** | Ukrainian fiscal receipt registrar (Програмний реєстратор розрахункових операцій) |
| **RLS** | Row Level Security — Supabase feature that restricts data access at the database level |
| **Migration** | A SQL file that changes the database structure in a trackable way |
| **Soft Delete** | Marking a record as deleted without actually removing it from the database |
| **Edge Function** | Server-side code that runs on Supabase's infrastructure (for webhooks, async jobs) |
| **STO** | Vehicle repair shop (СТО — Станція технічного обслуговування) |

---

## APPENDIX B: EMERGENCY CONTACTS AND RESOURCES

| Resource | Where |
|----------|-------|
| Project Repository | GitHub (your repo URL) |
| Supabase Dashboard | https://app.supabase.com |
| Supabase Status | https://status.supabase.com |
| GitHub Status | https://githubstatus.com |
| This Manual | `/control_center/HUMAN_OWNER_MASTER_MANUAL.md` |
| AI Knowledge Base | `/docs/` |
| Current Task | `/CURRENT_TASK.md` (repo root) |
| Decision Log | `/DECISION_LOG.md` (repo root) |

---

*This manual is a living document. Update it as the system evolves. When in doubt, consult the docs, check the Git history, and think before acting.*
