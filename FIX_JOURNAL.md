# Журнал виправлень Форсажу

Розпочато після глибокого аудиту **01.09.2026**. Правимо ітераціями: одна ітерація —
одна закінчена й перевірена річ. Нічого не починаємо, поки попереднє не зелене.

**Як користуватись:** дивись «Стан ітерацій» — там видно, що зроблено, що наступне.
Кожна ітерація має розділ із точними файлами й командами перевірки.

---

## Орієнтація в проєкті

| Що | Де |
|---|---|
| Робоче дерево (єдине) | `C:\Users\neo\Desktop\crm-forsage` |
| Весь UI — каса, товари, замовлення | `apps/web/src` |
| Electron-оболонка, SQLite, IPC, друк, ПРРО | `apps/desktop/src` |
| Хмарний API | `server/src` |
| Міграції Supabase | `supabase/migrations` |
| Готовий exe | `apps/desktop/release/Forsage-0.1.0-portable.exe` |
| Локальна база каси | `%LOCALAPPDATA%\Forsage\data\forsage.db` (+ `backups/`) |

**Правило:** екрани — завжди в `apps/web`. Desktop бере готовий web-build усередину exe.

### Ключові файли, які найчастіше чіпаємо

| Тема | Файл |
|---|---|
| Локальна БД, міграції, бекапи | `apps/desktop/src/db/localDatabase.ts`, `db/schema.ts` |
| Черга синхронізації (outbox) | `apps/desktop/src/repositories/syncRepository.ts` |
| Драйвер синхронізації (renderer) | `apps/web/src/lib/desktopSyncApi.ts`, `hooks/useDesktopOutboxSync.ts` |
| Міст web↔desktop (типи) | `apps/web/src/lib/desktopBridge.ts` |
| IPC: реєстрація / експорт / права | `apps/desktop/src/main.ts`, `preload.ts`, `security/desktopAuthorization.ts` |
| Каса | `apps/web/src/features/pos/` |
| ПРРО Кашалот | `apps/desktop/src/fiscal/cashalotService.ts` |

### Команди перевірки

```bash
pnpm verify                   # ⭐ усе одразу: typecheck ×3 + lint + 430 тестів
pnpm typecheck                # тільки типи (web + desktop + server)
pnpm test                     # тільки тести (98 + 115 + 217)
pnpm --filter=desktop dist    # перезбірка exe
```

Після **кожного** виправлення ганяємо `pnpm verify` — має бути exit 0.

---

## Стан ітерацій

| # | Ітерація | Пріоритет | Статус |
|---|---|---|---|
| 1 | Підключити тести десктопу | 🟠 фундамент | ✅ 01.09.2026 |
| 2 | Індикатор синхронізації + екран «застрягло» | 🔴 гроші | ⬜ |
| 3 | Відновлення локальної БД з бекапу | 🔴 гроші | ⬜ |
| 4 | Звести касу й вебку на одну гілку | 🟠 | ⬜ |
| 5 | Гігієна: сміття, мертвий код, хардкоди, доки | 🟡 | ⬜ |
| 6 | Безпека: троттлінг, хеші, шифрування, LAN | 🟡 | ⬜ |
| 7 | Авто-оновлення exe + офлайн-шляхи | 🟠/🟡 | ⬜ |

Легенда: ⬜ не почато · ⏳ в роботі · ✅ зроблено й перевірено

---

## Базовий стан на старті (01.09.2026)

Зафіксовано, щоб бачити, що ми нічого не зламали.

- Гілка: `agent/fix-supplier-creation` @ `871b01e`, дерево чисте
- typecheck web/desktop/server — **0 помилок**
- eslint web (`--max-warnings 0`) — **0**
- Тести: server **217** ✅ · web **98** ✅ · desktop **115** ✅ *(запускались вручну)*
- IPC-канали: 177, усі покриті правилами доступу, fail-closed
- preload ↔ main: 177/177 · web-bridge ↔ preload: 170/170
- Гроші: всюди цілі копійки (`INTEGER`), жодного `REAL`
- npm-вразливості: 20, **усі** в build-tooling, у рантайм не потрапляють

---

# Ітерація 1 — підключити тести десктопу

**Проблема.** `apps/desktop/tests/` містить 35 файлів і 115 тестів — включно з
критичними (`posStockSafety`, `moneySyncSafety`, `syncSelfHealing`,
`securityHardening`, `documentSyncSafety`). Вони **не запускаються ніде**:
у `apps/desktop/package.json` немає `vitest` у залежностях, немає `vitest.config`,
немає скрипта `test`. Тобто захист написано, але він не діє.

**Чому перше.** Це сітка безпеки для всіх наступних ітерацій — далі ми чіпаємо
синхронізацію й локальну БД, і без цих тестів правки будуть наосліп.

**Статус:** ✅ зроблено 01.09.2026

### Що зроблено

| Файл | Зміна |
|---|---|
| `apps/desktop/package.json` | `vitest ^3.2.4` у devDeps; скрипти `test` / `test:watch`; `typecheck` переведено на `tsconfig.test.json` |
| `apps/desktop/vitest.config.ts` | **новий** — `environment: node`, `include: tests/**/*.test.ts`, `fileParallelism: false` (кожен тест піднімає власну SQLite у WAL — паралельні відкриття на Windows нестабільні), `testTimeout: 30s` |
| `apps/desktop/tsconfig.test.json` | **новий** — тести тепер теж типізуються. `noEmit`, `rootDir: "."` (інакше TS6059 на `tests/` поруч із `src/`), `module: ES2022` (тестам потрібен `import.meta`) |
| `package.json` (корінь) | нові `typecheck`, `test`, **`verify`** — одна команда на всю перевірку |

**Важливо:** продакшн-збірка не змінилася. `tsconfig.json` лишився `module: CommonJS`
(Electron main вантажиться як CJS) — перевірив окремо, `tsc -p tsconfig.json` чистий.
ESM-режим живе **тільки** в `tsconfig.test.json`.

### Перевірено

```
pnpm verify → exit 0
  typecheck web ✅  desktop ✅ (тепер разом із tests/)  server ✅
  eslint web ✅ 0 попереджень
  тести: web 98 ✅ · desktop 115 ✅ · server 217 ✅   = 430
```

Раніше в цій цифрі було 315 — 115 тестів десктопу просто ніхто не запускав.
