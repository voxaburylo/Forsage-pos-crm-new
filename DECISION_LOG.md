# DECISION LOG

All significant technical and architectural decisions are recorded here.

---

## DEC-001: Monorepo over Polyrepo

**Date:** [DATE]  
**Decision:** Use a single monorepo for all applications and packages.  
**Reason:** Shared TypeScript types, shared UI components, and shared API client must be synchronized across frontend apps. A monorepo ensures type safety at build time and eliminates version drift between packages.  
**Alternative Considered:** Separate repos for web, desktop, mobile, server. Rejected because of the overhead of publishing and consuming shared packages via npm.  
**Consequences:** Slightly more complex CI/CD. Turborepo handles build caching to mitigate.

---

## DEC-002: Supabase over Self-Hosted PostgreSQL

**Date:** [DATE]  
**Decision:** Use Supabase managed PostgreSQL instead of self-hosting.  
**Reason:** Supabase provides managed PostgreSQL + Auth + Storage + Edge Functions + Realtime out of the box. For a solo-operator project, the operational overhead of self-hosting is not justified.  
**Alternative Considered:** Self-hosted PostgreSQL on VPS. Rejected due to maintenance burden (backups, upgrades, security patches).  
**Consequences:** Vendor dependency on Supabase. Mitigated by: standard SQL (portable), regular backups, no Supabase-specific ORM (raw SQL/query builder).

---

## DEC-003: Money as Integer Kopecks

**Date:** [DATE]  
**Decision:** Store all monetary values as INTEGER in kopecks (1/100 UAH).  
**Reason:** Floating-point arithmetic produces rounding errors. Integer arithmetic is exact. Display formatting (divide by 100) happens only at the UI layer.  
**Alternative Considered:** NUMERIC(10,2). Viable but requires care with arithmetic operations. INTEGER is simpler and safer for multiplication/division scenarios common in POS.  
**Consequences:** All API endpoints accept/return money as integers. Frontend must format for display.

---

## DEC-004: Tenant ID on Every Table from Day One

**Date:** [DATE]  
**Decision:** Include `tenant_id` column on every table, even though the initial deployment serves one store.  
**Reason:** Adding multi-tenancy retroactively requires migrating every table and every query. Building it in from the start costs almost nothing and eliminates the most expensive refactor in the project's future.  
**Alternative Considered:** Add tenant_id later when SaaS features are built. Rejected because every migration and every query would need modification.  
**Consequences:** Slightly more verbose queries. Small overhead. Massive future savings.

---

## DEC-005: Soft Delete for All Entities

**Date:** [DATE]  
**Decision:** Use `deleted_at TIMESTAMPTZ` soft delete instead of physical DELETE for all business entities.  
**Reason:** Accidental data loss is the #1 risk in a system handling real business data (sales, payments, customer records). Soft delete allows recovery. Physical deletion happens only in scheduled maintenance after verification.  
**Alternative Considered:** Physical delete with backup. Rejected because restoring a single record from a full backup is impractical.  
**Consequences:** All queries must include `WHERE deleted_at IS NULL`. Indexes should filter on this. Database grows over time — purge old soft-deleted records periodically.

---

## DEC-006: Express.js over Fastify/Hono

**Date:** [DATE]  
**Decision:** Use Express.js for the backend API server.  
**Reason:** Mature ecosystem, extensive middleware library, well-understood by AI agents (trained on massive Express.js corpus), easy to find help and examples. Performance difference is negligible at our scale (< 100 concurrent users).  
**Alternative Considered:** Fastify (faster), Hono (lighter). Rejected because AI code generation quality is highest with Express.js.  
**Consequences:** Slightly more boilerplate than Fastify. Acceptable trade-off for reliability.

---

## Template for New Decisions

```markdown
## DEC-XXX: [Title]

**Date:** [DATE]
**Decision:** [What was decided]
**Reason:** [Why this choice was made]
**Alternative Considered:** [What else was evaluated and why it was rejected]
**Consequences:** [What trade-offs or impacts this creates]
```

### When to Add a Decision

- Choosing between technologies or libraries
- Deciding on data model structure
- Establishing coding patterns or conventions
- Making trade-offs (speed vs. safety, simplicity vs. flexibility)
- Changing direction from a previous decision
- Any choice that a future developer would ask "why did they do it this way?"
