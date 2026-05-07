# Audit Templates

> Standardized audit procedures for the automotive CRM/ERP platform.
> Copy the relevant template, fill in, and store completed audits in `/docs/audits/completed/`.

---

## 1. Weekly Code & Data Audit

**Frequency:** Every Friday
**Duration:** 30–45 minutes
**Owner:** Project Owner or designated reviewer

### Checklist

```
Date: ___________
Auditor: ___________
Sprint: ___________

DATABASE HEALTH
[ ] Run `SELECT count(*) FROM products WHERE deleted_at IS NULL` — product count reasonable?
[ ] Check for orphan records: sale_items referencing deleted products
[ ] Verify no NULL tenant_id in any business table
[ ] Check debt balances: `SELECT customer_id, balance_kopecks FROM customers WHERE balance_kopecks < 0`
[ ] Confirm latest migration matches production schema
[ ] Verify backup exists and is < 24 hours old

CODE QUALITY
[ ] No hardcoded secrets in codebase (grep for API keys, passwords)
[ ] No console.log left in production code (except structured logger)
[ ] All new endpoints have input validation
[ ] All new endpoints have proper error handling (try/catch, 4xx/5xx responses)
[ ] TypeScript strict mode — no `any` types added this week
[ ] No direct Supabase client calls from frontend (must go through API client)

GIT HYGIENE
[ ] Main branch is clean and deployable
[ ] No stale feature branches older than 7 days
[ ] All merged PRs have at least a basic description
[ ] CHANGELOG_AI.md updated with this week's changes
[ ] No force pushes to main

SECURITY
[ ] RLS policies active on all business tables
[ ] JWT tokens validated on every protected endpoint
[ ] File upload endpoints validate file type and size
[ ] No SQL injection vectors (parameterized queries only)

PERFORMANCE
[ ] No N+1 query patterns in new code
[ ] Database indexes exist for all foreign keys used in JOINs
[ ] API response times < 500ms for core endpoints (POS, search)

FINDINGS:
___________________________________________
___________________________________________

ACTIONS REQUIRED:
___________________________________________
___________________________________________

SIGN-OFF: _________ DATE: _________
```

---

## 2. Sprint Completion Audit

**Frequency:** End of each sprint (every 1–2 weeks)
**Duration:** 1–2 hours
**Owner:** Project Owner

### Checklist

```
Date: ___________
Sprint: ___________
Tasks Planned: ___________
Tasks Completed: ___________
Tasks Carried Over: ___________

DELIVERY REVIEW
[ ] All completed tasks pass their acceptance criteria
[ ] QA checklist run for each completed task
[ ] No known P0/P1 bugs in completed features
[ ] Demo of each feature works end-to-end
[ ] CURRENT_TASK.md and CURRENT_PHASE.md updated

ARCHITECTURE REVIEW
[ ] No new technical debt introduced without a documented decision (DEC-XXX)
[ ] Database schema changes follow conventions (tenant_id, timestamps, soft delete)
[ ] API endpoints follow REST conventions and naming patterns
[ ] Frontend components use shared UI package, not inline styles

DOCUMENTATION REVIEW
[ ] New features documented in relevant spec files
[ ] API endpoints documented with request/response examples
[ ] Any new decisions recorded in DECISIONS_REGISTRY.md
[ ] CHANGELOG_AI.md has entries for all completed tasks

TEST COVERAGE
[ ] Critical business logic has unit tests (payment calculations, inventory math)
[ ] API endpoints have integration tests for happy path
[ ] POS workflows tested manually against QA checklist

DEPLOYMENT READINESS
[ ] All migrations tested on local Supabase
[ ] Seed data updated if schema changed
[ ] Environment variables documented for any new integrations
[ ] Rollback plan exists for schema changes

VELOCITY METRICS
- Story points planned: ___
- Story points completed: ___
- Velocity trend: Increasing / Stable / Decreasing
- Blockers encountered: ___
- AI agent sessions this sprint: ___

RETROSPECTIVE NOTES:
___________________________________________
___________________________________________

NEXT SPRINT PRIORITIES:
1. ___________________________________________
2. ___________________________________________
3. ___________________________________________

SIGN-OFF: _________ DATE: _________
```

---

## 3. Monthly Business & System Audit

**Frequency:** Last day of each month
**Duration:** 2–3 hours
**Owner:** Project Owner

### Checklist

```
Date: ___________
Month: ___________

BUSINESS METRICS (from Reports module or manual check)
[ ] Total sales this month: _________ UAH
[ ] Total orders created: _________
[ ] Total orders completed: _________
[ ] Total orders cancelled: _________ (check reasons)
[ ] Outstanding customer debt total: _________ UAH
[ ] New customers added: _________
[ ] Unprocessed leads count: _________ (should be 0)
[ ] Cash mismatch events: _________

SYSTEM HEALTH
[ ] Uptime percentage this month: _________%
[ ] Average API response time: _________ ms
[ ] Error rate (5xx responses): _________%
[ ] Database size growth: _________ MB
[ ] Storage usage (photos, attachments): _________ MB
[ ] Supabase plan usage vs limits: OK / Warning / Critical

DATA INTEGRITY
[ ] Run full orphan record check across all tables
[ ] Verify inventory quantities match: receipts - writeoffs - sales = current stock
[ ] Verify payment ledger balances: sum of payments = sum of sales (excluding debt)
[ ] Check for duplicate customers (same phone number)
[ ] Check for duplicate products (same barcode)

SECURITY AUDIT
[ ] Review Supabase auth logs for unusual activity
[ ] Check for failed login attempts > 10 from same IP
[ ] Verify all user accounts are still active employees
[ ] Review and rotate any API keys approaching expiry
[ ] Confirm SSL certificates are valid

BACKUP VERIFICATION
[ ] Download and verify latest backup can be restored
[ ] Test restore on local Supabase instance
[ ] Confirm backup retention policy (30 days minimum)

COST REVIEW
[ ] Supabase monthly cost: _________ USD
[ ] Hosting cost (server): _________ USD
[ ] Third-party API costs (Telegram, fitment, OCR): _________ USD
[ ] Total monthly infrastructure cost: _________ USD
[ ] Cost per transaction (total cost / total sales count): _________ USD

ROADMAP CHECK
[ ] Current phase on track? YES / NO / BEHIND
[ ] Tasks completed this month: _________
[ ] Critical blockers: ___________________________________________
[ ] Phase completion ETA still valid? YES / Needs adjustment

FINDINGS:
___________________________________________
___________________________________________

DECISIONS NEEDED:
___________________________________________
___________________________________________

SIGN-OFF: _________ DATE: _________
```

---

## 4. Pre-Launch Audit (One-Time Before Go-Live)

**Use:** Before the platform goes live with real customers and real money.

### Checklist

```
Date: ___________
Target Launch Date: ___________

CRITICAL PATH
[ ] POS can complete a sale end-to-end
[ ] Payment is recorded correctly
[ ] Inventory decrements on sale
[ ] Receipt prints/displays correctly
[ ] Customer can be created and linked to sale
[ ] Debt sale records balance correctly
[ ] Cash drawer reconciliation works at shift close
[ ] Search finds products by barcode, name, article, OEM
[ ] Returns process correctly (inventory restored, payment reversed)

DATA MIGRATION
[ ] Existing product catalog imported and verified
[ ] Existing customer list imported (if applicable)
[ ] Opening inventory balances entered and verified
[ ] Price lists current and correct

INFRASTRUCTURE
[ ] Production Supabase project configured
[ ] Production server deployed and accessible
[ ] Domain/SSL configured
[ ] Environment variables set (production keys, not dev)
[ ] Backup automation verified and tested
[ ] Monitoring/alerting configured (uptime, error rates)

USER READINESS
[ ] All user accounts created with correct roles
[ ] Users trained on basic POS workflow
[ ] Users trained on shift open/close procedure
[ ] Emergency contact list (developer, owner) posted
[ ] Printed quick-reference card at each workstation

ROLLBACK PLAN
[ ] Can revert to manual operations if system fails?
[ ] Backup of all data before go-live stored offline?
[ ] Known issues documented with workarounds?

GO/NO-GO DECISION: _________ 
AUTHORIZED BY: _________
DATE: _________
```

---

## 5. Disaster Recovery Audit (Quarterly)

**Frequency:** Every 3 months
**Duration:** 2–4 hours (includes actual recovery test)

### Checklist

```
Date: ___________
Quarter: ___________

BACKUP SYSTEMS
[ ] Automated daily backups running? Verify last 7 days exist
[ ] Manual backup procedure documented and tested
[ ] Backup stored in separate location from production
[ ] Backup encryption verified

RECOVERY TEST
[ ] Download latest backup
[ ] Restore to fresh local Supabase instance
[ ] Verify row counts match production (within 24h tolerance)
[ ] Verify a sample of 10 random records are correct
[ ] Measure restore time: _________ minutes
[ ] Document any issues during restore

SCENARIO DRILLS (pick 1 each quarter, rotate)
[ ] Scenario A: Database corruption — can we restore from backup?
[ ] Scenario B: Server down — can we redeploy in < 1 hour?
[ ] Scenario C: Supabase outage — can we operate offline?
[ ] Scenario D: Security breach — can we rotate all credentials in < 30 min?

RECOVERY TIME OBJECTIVES
- Target RTO (Recovery Time Objective): < 2 hours
- Actual tested RTO this quarter: _________ hours
- Target RPO (Recovery Point Objective): < 24 hours data loss
- Actual tested RPO: _________ hours

IMPROVEMENTS NEEDED:
___________________________________________
___________________________________________

SIGN-OFF: _________ DATE: _________
```

---

## Completed Audits Storage

Store all completed audit documents in:

```
/docs/audits/completed/
  WEEKLY_2025-W03.md
  SPRINT_2025-S01.md
  MONTHLY_2025-01.md
  PRELAUNCH_2025-02-15.md
  DR_2025-Q1.md
```

Naming convention: `{TYPE}_{DATE/PERIOD}.md`
