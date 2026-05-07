# PROMPT FACTORY

## Reusable AI Agent Prompt Templates

---

## PROMPT_01: DATABASE MIGRATION

Use when: Creating a new Supabase migration file.

```markdown
## CONTEXT
You are building an AI-first automotive CRM/ERP SaaS platform.
Database: Supabase PostgreSQL.
All tables must include: tenant_id (UUID, NOT NULL), created_at, updated_at, deleted_at (soft delete).
Money stored as INTEGER (kopecks). Quantities as NUMERIC(12,3).
All tables must have RLS enabled with tenant_isolation policy.

## CURRENT STATE
[Paste relevant section of SPEC_DATABASE.md]
[Paste existing migration files list]

## TASK
Create a Supabase migration file for: [DESCRIBE WHAT TABLES/COLUMNS TO CREATE OR ALTER]

## REQUIREMENTS
1. Migration file named: YYYYMMDDHHMMSS_description.sql
2. Include CREATE TABLE with all columns, types, defaults, constraints
3. Include indexes for foreign keys and common query patterns
4. Include RLS policy: tenant_isolation
5. Include updated_at trigger
6. Include search_vector + trigger if entity is searchable
7. Add a comment block at top explaining the migration
8. Include rollback SQL in a comment block at bottom

## OUTPUT
Output the complete SQL migration file content.
```

---

## PROMPT_02: BACKEND ENDPOINT

Use when: Building a new API endpoint (route + service + validation).

```markdown
## CONTEXT
You are building the backend for an automotive CRM/ERP platform.
Tech: Node.js + Express.js + TypeScript + Supabase PostgreSQL.
Pattern: Route handler → Zod validation → Service function → Database query.
All endpoints require auth middleware. Role guards where needed.
Error format: { error: { code, message, status, details? } }

## CURRENT STATE
[Paste relevant SPEC module file]
[Paste relevant database table definition from SPEC_DATABASE.md]
[Paste existing route/service files if extending]

## TASK
Build the following endpoint: [METHOD] [PATH]
Purpose: [WHAT IT DOES]
Roles allowed: [WHICH ROLES]

## REQUIREMENTS
1. Create/update: /server/src/routes/{module}.ts
2. Create/update: /server/src/services/{module}.ts
3. Create/update: /server/src/validators/{module}.ts
4. Use Zod for request body/query validation
5. Use parameterized queries (no SQL string concatenation)
6. Include proper error handling with specific error codes
7. Include tenant_id filtering in all queries
8. Return appropriate HTTP status codes
9. Add TypeScript types for request/response

## OUTPUT
Output complete file contents for all files that need to be created or modified.
```

---

## PROMPT_03: FRONTEND PAGE

Use when: Building a new page/view in the web application.

```markdown
## CONTEXT
You are building the web CRM for an automotive parts business.
Tech: React 18 + TypeScript + Vite + Zustand + Tailwind CSS.
Components come from @packages/ui.
API calls via @packages/api-client.
Language: Ukrainian UI text, English code/comments.

## CURRENT STATE
[Paste relevant SPEC module file]
[Paste relevant API endpoints from backend]
[Paste existing page components if extending]

## TASK
Build the following page: [PAGE NAME]
Route: [/path]
Purpose: [WHAT THE USER DOES HERE]

## REQUIREMENTS
1. Create: /apps/web/src/pages/{PageName}.tsx
2. Create any needed components in /apps/web/src/components/{Module}/
3. Use Zustand store for state management
4. Handle loading, error, and empty states
5. Implement pagination for list views
6. Use Ukrainian text for all labels and messages
7. Make responsive (desktop + tablet breakpoints)
8. Include proper TypeScript types
9. Use semantic HTML elements
10. Implement keyboard navigation where applicable

## UI SPECIFICATIONS
[Describe the layout, sections, interactions]

## OUTPUT
Output complete file contents for all components.
```

---

## PROMPT_04: FULLSTACK FEATURE

Use when: Building a complete feature across all layers.

```markdown
## CONTEXT
You are building a fullstack feature for an automotive CRM/ERP platform.
Stack: React + Express + Supabase PostgreSQL.
This feature spans: database + backend + frontend.

## PROJECT CONTEXT
[Paste PROJECT_CONTEXT.md]

## TASK SPEC
[Paste full TASK-XXX.md content]

## MODULE SPEC
[Paste relevant SPEC_*.md content]

## DATABASE SCHEMA
[Paste relevant tables from SPEC_DATABASE.md]

## EXISTING CODE
[Paste relevant existing files]

## REQUIREMENTS
Build this feature end-to-end:
1. Database migration (if needed)
2. Backend service + route + validation
3. API client method in @packages/api-client
4. Frontend page/component with full UX
5. TypeScript types in @packages/types
6. All CRUD operations working
7. Error handling at every layer
8. Loading states in UI
9. Empty states in UI
10. Responsive layout

## OUTPUT FORMAT
Output files in order:
1. Migration SQL
2. Types (packages/types)
3. Server service
4. Server route
5. Server validator
6. API client method
7. Frontend components
8. Frontend page
```

---

## PROMPT_05: BUG FIX

Use when: Diagnosing and fixing a bug.

```markdown
## CONTEXT
Platform: Automotive CRM/ERP.
Stack: React + Express + Supabase PostgreSQL.

## BUG DESCRIPTION
[What is happening vs what should happen]

## STEPS TO REPRODUCE
[1. Go to... 2. Click... 3. Observe...]

## ERROR MESSAGES
[Paste console errors, API errors, stack traces]

## RELEVANT CODE
[Paste the files that are likely involved]

## DATABASE STATE
[Paste any relevant query results or table state]

## TASK
1. Identify the root cause of this bug
2. Explain why it happens
3. Provide the minimal fix
4. Identify if there are similar bugs elsewhere in the codebase
5. Suggest a preventive measure (test, validation, guard)

## OUTPUT
Output the exact file changes needed to fix this bug.
```

---

## PROMPT_06: ARCHITECTURE AUDIT

Use when: Reviewing system architecture for issues. Best used with Claude Code.

```markdown
## CONTEXT
You are the architect for an automotive CRM/ERP SaaS platform.
Review the current state of the system for architectural issues.

## ARCHITECTURE SPEC
[Paste ARCHITECTURE_OVERVIEW.md]

## CURRENT CODE STRUCTURE
[Paste output of: find /server/src -name "*.ts" | head -50]
[Paste output of: find /apps/web/src -name "*.tsx" | head -50]

## DATABASE STATE
[Paste current migration file list]

## QUESTIONS TO ANSWER
1. Are there any modules that violate the planned architecture?
2. Are there circular dependencies between modules?
3. Are there any database tables missing indexes for common queries?
4. Are there any API endpoints without proper auth/role guards?
5. Are there any services with business logic that should be in a transaction but is not?
6. Are there any TypeScript `any` types that should be properly typed?
7. Are there any RLS policies missing or incorrectly configured?
8. Are there any error handling gaps?
9. Is the code organized consistently across modules?
10. What is the most critical architectural risk right now?

## OUTPUT
Provide a structured audit report with:
- CRITICAL issues (fix immediately)
- WARNING issues (fix this sprint)
- INFO observations (fix when convenient)
For each issue: location, description, recommended fix.
```

---

## PROMPT_07: CLAUDE SURGERY

Use when: Making a precise, targeted change to existing code. Best used with Claude Code or Cursor.

```markdown
## CONTEXT
Precise code modification task. Do not refactor or change anything beyond the specific request.

## FILE TO MODIFY
[Paste the exact file content]

## CHANGE REQUEST
[Describe exactly what needs to change]

## CONSTRAINTS
1. Make the MINIMUM change necessary
2. Do not rename variables or functions
3. Do not reformat code
4. Do not add features beyond the request
5. Preserve all existing functionality
6. If the change requires modifying other files, list them but do not modify them in this prompt

## OUTPUT
Output ONLY the changed sections using this format:
- Line X-Y: [old code] → [new code]
- Or provide the full file if changes are extensive
```

---

## PROMPT_08: GEMINI LOGIC REVIEW

Use when: Having Gemini review code for logical errors. 

```markdown
## CONTEXT
Review this code for logical errors, edge cases, and potential bugs.
This is part of an automotive CRM/ERP platform handling real business data (money, inventory, customer records).

## CODE TO REVIEW
[Paste the code]

## WHAT THIS CODE DOES
[Brief explanation of the feature]

## BUSINESS RULES
[Paste relevant rules from the spec]

## REVIEW CHECKLIST
1. Are all edge cases handled? (null, undefined, empty arrays, zero values)
2. Are money calculations using integers (not floats)?
3. Are database transactions used where multiple tables are updated?
4. Is there any possibility of race conditions?
5. Are all user inputs validated before processing?
6. Is error handling comprehensive? (every async call has catch)
7. Are there any infinite loops or recursive calls without base cases?
8. Is tenant_id always included in queries?
9. Can any operation leave the database in an inconsistent state?
10. Are there any security vulnerabilities? (SQL injection, XSS, IDOR)

## OUTPUT
For each issue found:
- Severity: CRITICAL / WARNING / INFO
- Location: file, line
- Description: what is wrong
- Fix: recommended solution
```

---

## PROMPT_09: UI POLISH

Use when: Improving the visual quality and usability of a page.

```markdown
## CONTEXT
Polish the UI of this page for a Ukrainian automotive parts business.
Design principles: Professional, fast, minimal, functional. No decorative elements.
Colors: Neutral grays + blue accent. High contrast for readability.
Typography: Clean sans-serif. Clear hierarchy.
The primary users are cashiers and managers who use this all day.

## CURRENT CODE
[Paste the component code]

## SCREENSHOT DESCRIPTION
[Describe what it currently looks like, or paste screenshot]

## POLISH REQUIREMENTS
1. Consistent spacing (use Tailwind spacing scale)
2. Proper typography hierarchy (size, weight, color)
3. Loading state with skeleton placeholders
4. Empty state with helpful message
5. Error state with clear message and retry button
6. Hover states on clickable elements
7. Focus states for keyboard navigation
8. Responsive behavior (desktop → tablet)
9. Ukrainian text for all user-facing strings
10. Table column alignment (numbers right-aligned, text left-aligned)

## OUTPUT
Output the polished component code.
```

---

## PROMPT_10: REPO REFACTOR

Use when: Reorganizing code structure across multiple files.

```markdown
## CONTEXT
Refactoring the codebase for better organization. This is a structural change, not a feature change.
The system must work exactly the same after the refactor.

## CURRENT STRUCTURE
[Show current file tree of affected area]

## TARGET STRUCTURE  
[Show desired file tree]

## REFACTOR PLAN
[What moves where, what gets renamed, what gets split/merged]

## CONSTRAINTS
1. Zero functional changes — behavior identical before and after
2. All imports updated correctly
3. All tests still pass
4. No files left orphaned (referenced but deleted)
5. TypeScript types remain correct
6. Build still succeeds

## OUTPUT
Output the refactoring steps in order:
1. Create new files
2. Move content
3. Update imports
4. Delete old files
5. Verify command (build + test)
```

---

## PROMPT_11: TASK CLOSE REVIEW

Use when: Final check before marking a task as DONE.

```markdown
## CONTEXT
Review a completed task before marking it as DONE and merging to main.

## TASK SPEC
[Paste TASK-XXX.md]

## ACCEPTANCE CRITERIA
[List from the task spec]

## CODE CHANGES
[Paste git diff or list of changed files]

## REVIEW CHECKLIST
1. Does every acceptance criterion have corresponding code?
2. Is the code consistent with the module spec?
3. Are there any TODO/FIXME/HACK comments that need resolution?
4. Are error states handled in both backend and frontend?
5. Is the feature accessible without documentation?
6. Are all new API endpoints documented?
7. Are database changes backwards-compatible?
8. Is there any sensitive data logged or exposed?
9. Does the feature work with existing seed data?
10. Is the code clean enough that another developer (human or AI) can understand it?

## OUTPUT
VERDICT: PASS | FAIL
If FAIL: list what needs to be fixed before merge.
If PASS: any suggestions for follow-up improvements (not blocking).
```
