# QA CHECKLIST — MASTER

## Use after every completed task before merge.

---

## A. FUNCTIONALITY

- [ ] Feature does what the task spec describes
- [ ] All acceptance criteria verified individually
- [ ] Happy path works end-to-end
- [ ] Error path shows user-friendly message
- [ ] Empty state renders correctly (no data scenario)
- [ ] Edge cases handled (max length, special characters, Ukrainian characters: і,ї,є,ґ)
- [ ] Zero/null values handled (zero price, null customer, empty list)
- [ ] Concurrent usage safe (two users editing same record)

## B. DATA INTEGRITY

- [ ] Correct records created in database
- [ ] Related records updated (inventory after sale, debt after debt sale)
- [ ] No orphaned records possible
- [ ] Soft delete works (deleted_at set, not physically removed)
- [ ] tenant_id populated on all new records
- [ ] Monetary values stored as integers (kopecks)
- [ ] Timestamps stored with timezone (TIMESTAMPTZ)

## C. API QUALITY

- [ ] Correct HTTP status codes (200, 201, 400, 401, 403, 404, 500)
- [ ] Request validation returns helpful error messages
- [ ] Auth middleware present on all endpoints
- [ ] Role guard present where needed
- [ ] Response matches documented API contract
- [ ] Pagination works (page, limit, total count)
- [ ] No sensitive data in response (passwords, internal IDs not needed by frontend)

## D. FRONTEND QUALITY

- [ ] Loading spinner/skeleton shown during API calls
- [ ] Error messages shown in Ukrainian
- [ ] Forms validate before submit
- [ ] Button disabled during submission (prevent double-click)
- [ ] Success feedback shown after action (toast/notification)
- [ ] Navigation works (back button, breadcrumbs)
- [ ] Responsive on desktop (1920x1080 and 1366x768)
- [ ] No console errors in browser DevTools

## E. SECURITY

- [ ] Input validated on both client and server
- [ ] SQL queries parameterized
- [ ] No XSS vectors (user content sanitized before display)
- [ ] RLS policies active on affected tables
- [ ] No secrets in code (API keys, passwords)
- [ ] CORS configured correctly

## F. CODE QUALITY

- [ ] TypeScript strict mode — no `any` types
- [ ] No console.log left in code
- [ ] No TODO/FIXME blocking merge
- [ ] Function names descriptive
- [ ] File organization matches architecture spec
- [ ] Imports clean (no unused imports)

## G. GIT

- [ ] Feature branch up to date with main/develop
- [ ] Commit messages descriptive
- [ ] No merge conflicts
- [ ] No .env files in diff
- [ ] CHANGELOG_AI.md updated

---

# QA CHECKLIST — POS SPECIFIC

Use additionally for any POS-related task.

- [ ] Barcode scan adds product correctly
- [ ] Search returns results in under 200ms
- [ ] Receipt total calculates correctly
- [ ] Discount cannot go below min_price
- [ ] Split payment amounts sum to total
- [ ] Suspended receipt saves and restores correctly
- [ ] Shift close calculates correct expected cash
- [ ] Change calculation is correct for cash payments
- [ ] Hotkeys work as documented
- [ ] Sound effects play on correct events (if implemented)
- [ ] Receipt tabs switch without data loss

---

# QA CHECKLIST — DATABASE MIGRATION

Use for any task that includes a migration.

- [ ] Migration file named with correct timestamp prefix
- [ ] CREATE TABLE includes all required columns
- [ ] All columns have appropriate types and defaults
- [ ] Foreign keys reference correct tables
- [ ] Indexes created for foreign keys and common queries
- [ ] RLS policy added and enabled
- [ ] updated_at trigger added
- [ ] search_vector trigger added (if searchable entity)
- [ ] Migration runs without error: `supabase db reset`
- [ ] Rollback SQL documented in comments
- [ ] No breaking changes to existing tables (additive only in MVP)

---

# AUDIT TEMPLATE — WEEKLY

File: `/docs/audits/AUDIT_YYYY_WXX.md`

```markdown
# Weekly Audit — [YYYY-WXX]

**Date:** [Date]
**Auditor:** [Name]

## Architecture Check
- [ ] Code structure matches architecture spec
- [ ] No unexpected files or directories
- Findings: [none / describe issues]

## Data Integrity Check
- [ ] Ran audit-data.sql script
- [ ] No orphaned records found
- [ ] No duplicate products (same OEM)
- [ ] No negative inventory
- Findings: [none / describe issues]

## Security Check
- [ ] No credentials in code
- [ ] RLS policies verified
- [ ] Auth logs reviewed (no anomalies)
- Findings: [none / describe issues]

## Performance Check
- [ ] API response times acceptable (< 2s)
- [ ] No slow queries in Supabase dashboard
- [ ] Storage usage reasonable
- Findings: [none / describe issues]

## Action Items
1. [action] — Priority: [high/medium/low] — Assigned to: [who]
2. ...
```
