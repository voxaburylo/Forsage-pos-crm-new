# WORKFLOW SPECIFICATIONS

---

## WORKFLOW 1: GIT WORKFLOW

### Branch Strategy

```
main              ← always deployable, protected
  └── develop     ← integration branch
       └── feature/TASK-XXX-short-desc  ← one branch per task
       └── hotfix/short-desc            ← emergency fix → main
```

### Feature Branch Lifecycle

```
1. git checkout develop && git pull
2. git checkout -b feature/TASK-045-pos-barcode-search
3. ... work on the feature ...
4. git add . && git commit -m "TASK-045: implement barcode search in POS"
5. git push origin feature/TASK-045-pos-barcode-search
6. Create Pull Request: feature/TASK-045 → develop
7. PR Review (AI or human)
8. Merge to develop
9. When develop is stable: merge develop → main
10. Tag release: git tag v0.X.Y
```

### Commit Message Format

```
TASK-XXX: short description of what changed

[optional longer description]

- Detail 1
- Detail 2
```

Examples:
```
TASK-021: create products table migration
TASK-045: implement universal product search endpoint
TASK-076: build POS page layout with receipt and search panels
HOTFIX: fix null pointer in customer debt calculation
```

### PR Template

```markdown
## TASK-XXX: [Title]

### What changed
[Brief description]

### How to test
1. [Step 1]
2. [Step 2]

### Checklist
- [ ] QA checklist completed
- [ ] No console.log in code
- [ ] No .env changes committed
- [ ] CHANGELOG_AI.md updated
- [ ] TypeScript compiles without errors
```

---

## WORKFLOW 2: SUPABASE WORKFLOW

### Local Development

```bash
# Start local Supabase
supabase start

# Create new migration
supabase migration new create_products_table

# Edit migration file in supabase/migrations/

# Apply migrations (reset local DB)
supabase db reset

# Verify
supabase db dump  # check schema
```

### Deploy to Production

```bash
# Step 1: Backup production
# Download from Supabase Dashboard → Database → Backups

# Step 2: Link to production project
supabase link --project-ref YOUR_PROJECT_REF

# Step 3: Push migrations
supabase db push

# Step 4: Verify
# Open Supabase Dashboard → Table Editor → check tables exist
```

### Seed Data

```bash
# Development seed data lives in supabase/seeds/seed.sql
# Applied automatically on: supabase db reset

# Seed data should include:
# - One tenant
# - One owner user
# - 5-10 sample customers
# - 20-30 sample products with barcodes
# - 3-5 suppliers
# - Sample categories and brands
# - A few sample sales and orders
```

### Edge Functions

```bash
# Create new function
supabase functions new telegram-webhook

# Deploy
supabase functions deploy telegram-webhook

# Set secrets
supabase secrets set TELEGRAM_BOT_TOKEN=xxx

# Test locally
supabase functions serve telegram-webhook
curl -X POST http://localhost:54321/functions/v1/telegram-webhook ...
```

---

## WORKFLOW 3: AI FACTORY WORKFLOW

### Daily Operating System

```
MORNING (15 min):
  1. Check GitHub board: any blocked tasks? failed builds?
  2. Check Supabase dashboard: DB healthy?
  3. Review CURRENT_TASK.md: what is the active task?
  4. Prepare context for AI session

AI SESSION (2-4 hours per task):
  1. Open AI agent (DeepSeek for building, Claude for architecture)
  2. Feed context sandwich:
     - PROJECT_CONTEXT.md
     - Relevant SPEC file
     - TASK-XXX.md
     - Relevant prompt from PROMPT_FACTORY.md
     - Existing code files if needed
  3. Let AI generate code
  4. Review output: does it match the spec?
  5. Copy code to correct files in repository
  6. Test locally
  7. Fix issues (iterate with AI if needed)
  8. Commit to feature branch

POST-SESSION (10 min):
  1. Push feature branch
  2. Create PR (if task is complete)
  3. Run QA checklist
  4. Update CURRENT_TASK.md
  5. Update CHANGELOG_AI.md if task is merged
```

### Task Protocol

```
START TASK:
  1. Verify all dependencies are MERGED
  2. Create feature branch
  3. Read TASK-XXX.md completely
  4. Identify which files will be created/modified
  5. Feed context to AI agent

DURING TASK:
  1. One AI session per task (do not mix tasks)
  2. If task is too large, break into subtasks
  3. Test after each meaningful code chunk
  4. Commit frequently (at least once per working session)

COMPLETE TASK:
  1. All acceptance criteria met
  2. QA checklist passed
  3. PR created and reviewed
  4. Merged to develop
  5. CURRENT_TASK.md updated
  6. CHANGELOG_AI.md updated
  7. GitHub board task moved to DONE
```

### Stable Checkpoint Protocol

After every 5-10 tasks (approximately every 1-2 weeks):

```
1. Merge develop → main
2. Tag release: git tag v0.X.Y
3. Run full system test (not just the last feature)
4. Backup Supabase database
5. Document current state in CURRENT_PHASE.md
6. Review architecture: are we drifting from the plan?
7. Update PROJECT_CONTEXT.md if scope changed
8. Celebrate progress (seriously — this prevents burnout)
```

### Anti-Fail Protocol

```
BEFORE EVERY AI SESSION:
  ✓ Is the task spec written?
  ✓ Is the relevant module spec available?
  ✓ Are dependencies MERGED (not just "done")?
  ✓ Is main branch stable?

DURING AI OUTPUT REVIEW:
  ✓ Does the AI output match the spec?
  ✓ Are database queries using tenant_id?
  ✓ Is money stored as integer?
  ✓ Are there proper error handlers?
  ✓ Is there input validation?
  ✓ Does it compile? (run tsc)

BEFORE MERGING:
  ✓ QA checklist complete?
  ✓ No secrets in code?
  ✓ No console.log debugging?
  ✓ Feature branch up to date with develop?
```

### Disaster Recovery Protocol

```
SCENARIO: AI generated bad code that was merged and broke the system.

IMMEDIATE:
  1. Stop all development
  2. git log --oneline -20 (find last good state)
  3. git revert <bad-commits> (create revert commits)
  4. Push to main
  5. Verify system works

ROOT CAUSE:
  1. Which task was it?
  2. Was the spec insufficient?
  3. Was the context fed to AI incomplete?
  4. Was QA skipped?

PREVENTION:
  1. Update the relevant spec with missing info
  2. Add a QA item to prevent this specific bug class
  3. Document in DECISION_LOG.md
```

---

## WORKFLOW 4: AI AGENT SELECTION

### Decision Tree

```
Task: Architecture decision or system design
  → Claude Code

Task: Write new database migration
  → Claude Code (designs schema) → DeepSeek (writes SQL)

Task: Build backend endpoint
  → DeepSeek (with PROMPT_02 template)

Task: Build frontend page
  → DeepSeek or Cursor (with PROMPT_03 template)

Task: Build fullstack feature
  → DeepSeek (with PROMPT_04 template)

Task: Fix a bug
  → Gemini (diagnosis) → DeepSeek or Cursor (fix)

Task: Review code for issues
  → Gemini (with PROMPT_08 template)

Task: Refactor code structure
  → Cursor (multi-file operations)

Task: Write documentation
  → Claude Code

Task: Targeted code change (precise edit)
  → Claude Code or Cursor (with PROMPT_07 template)
```

### Context Limits Per Agent

| Agent | Context Window | Strategy |
|-------|---------------|----------|
| Claude Code | ~200K tokens | Can handle PROJECT_CONTEXT + full spec + multiple code files |
| DeepSeek | ~64-128K tokens | Feed task spec + module spec + relevant code only |
| Cursor | Varies | Works best with files open in IDE + selected context |
| Gemini | ~128K-1M tokens | Can review large codebases, feed generously |

### Handoff Protocol

When a task requires multiple agents:

```
Agent A (Claude) produces: architecture decision + spec
  ↓ Save output to /docs/ or task file
Agent B (DeepSeek) receives: Claude's spec as context → produces code
  ↓ Save code to feature branch
Agent C (Gemini) receives: DeepSeek's code → produces review
  ↓ Issues documented
Agent B (DeepSeek) receives: Gemini's issues → produces fixes
  ↓ Final code committed
```

Each handoff is a file save. No agent-to-agent direct communication. You are the router.
