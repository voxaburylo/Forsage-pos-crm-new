# CHANGELOG — AI DEVELOPMENT LOG

All notable changes built by AI agents are documented here.

Format: [TASK-XXX] Description — Agent Used — Date

---

## [Unreleased]

### Added
- Project documentation ecosystem created — Claude Code — [DATE]

### Changed
_None yet._

### Fixed
_None yet._

---

## How to Update

After every merged task, add an entry under `[Unreleased]` in the appropriate section:

- **Added**: New features, new files, new endpoints
- **Changed**: Modified existing functionality
- **Fixed**: Bug fixes
- **Removed**: Deleted features or deprecated code

When a release is tagged (e.g., v0.1.0), move everything from `[Unreleased]` to a new version section:

```
## [v0.1.0] — 2026-XX-XX

### Added
- [TASK-001] Monorepo initialization — DeepSeek — 2026-XX-XX
- [TASK-016] Database schema: tenants, users tables — Claude Code — 2026-XX-XX
...
```

### Entry Format

```
- [TASK-XXX] Short description of what was built — Agent Name — YYYY-MM-DD
```

Example entries:
```
- [TASK-045] Universal product search (barcode + OEM + name) — DeepSeek — 2026-05-15
- [TASK-082] Sale creation with inventory transaction — DeepSeek — 2026-05-22
- [TASK-123] Telegram bot inbound message processing — Claude Code — 2026-06-01
- [HOTFIX] Fix negative inventory on concurrent sales — Gemini+Cursor — 2026-06-03
```
