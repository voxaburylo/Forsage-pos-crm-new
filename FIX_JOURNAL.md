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
pnpm verify                   # ⭐ усе одразу: typecheck ×3 + lint + усі тести
pnpm typecheck                # тільки типи (web + desktop + server)
pnpm test                     # тільки тести (web + desktop + server)
pnpm --filter=desktop dist    # перезбірка exe
```

Після **кожного** виправлення ганяємо `pnpm verify` — має бути exit 0.

---

## Стан ітерацій

| # | Ітерація | Пріоритет | Статус |
|---|---|---|---|
| 1 | Підключити тести десктопу | 🟠 фундамент | ✅ 01.09.2026 |
| 2 | Індикатор синхронізації + екран «застрягло» | 🔴 гроші | ✅ 01.09.2026 |
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

---

# Ітерація 2 — індикатор синхронізації + екран «застрягло»

**Проблема.** Каса ніяк не показувала, що продажі не доїхали на сервер:

- `useDesktopOutboxSync` клав помилку в `lastError`, а `LocalSyncAgent` повертав
  `null` і викидав її в нікуди
- тип `DesktopSyncStatus` (`pending` / `retrying` / `stuck`) не мав **жодного** споживача
- push ішов із `silent: true` — навіть тост не спливав
- бейдж «N в черзі» у касі читав **браузерну** IndexedDB-чергу, яка в desktop
  завжди 0 — тобто касир бачив «0» і коли все добре, і коли нічого не їхало
- після 30 спроб (`MAX_OUTBOX_ATTEMPTS`) операція ставала dead-letter мовчки,
  без жодного способу її побачити чи повторити

За чеклистом `LOCAL_FIRST_PREFLIGHT_CHECKLIST.md` (розділ 6) це блокер:
*«Продаж пройшов локально, але після інтернету не синхронізувався»*.

**Статус:** ✅ зроблено 01.09.2026

### Що зроблено

**Desktop — нові дані з локальної БД**

| Файл | Зміна |
|---|---|
| `apps/desktop/src/repositories/syncRepository.ts` | `listStuck(limit)` — операції з вичерпаними спробами; `retryStuck(sequences?)` — ручне повернення в чергу |
| `apps/desktop/src/db/localTypes.ts` | тип `LocalSyncStuckOperation` (без `payload` — у накладної він на сотні КБ) |
| `apps/desktop/src/main.ts` | IPC `desktop:sync:list-stuck`, `desktop:sync:retry-stuck` |
| `apps/desktop/src/preload.ts` | `sync.listStuck`, `sync.retryStuck` |

Права доступу окремо не додавали: префікс `desktop:sync:` вже дає `ALL_ROLES`.
Це навмисно — касир має бачити свої невідправлені чеки й уміти їх повторити,
не чекаючи власника.

**Ключове рішення в `retryStuck`:** чіпаємо **лише** рядки з `attempts >= MAX`.
Ті, що ще ретраяться самі, не торкаємо — скидання їхнього `next_attempt_at`
зламало б експоненційний backoff і влаштувало б шторм запитів на сервер.

**Web — те, що бачить людина**

| Файл | Зміна |
|---|---|
| `apps/web/src/lib/desktopBridge.ts` | тип `DesktopSyncStuckOperation` + методи в мості |
| `apps/web/src/lib/desktopSyncApi.ts` | `listDesktopStuckOperations`, `retryDesktopStuckOperations` (одразу запускає синк, щоб людина побачила результат) |
| `apps/web/src/hooks/useDesktopSyncHealth.ts` | **новий** — опитує стан кожні 10 с + миттєво на подію `forsage:desktop-sync-completed` |
| `apps/web/src/components/SyncHealthIndicator.tsx` | **новий** — значок у шапці, теми `light` / `dark` |
| `apps/web/src/components/SyncHealthModal.tsx` | **новий** — список застряглих, «Повторити» на рядок і «Повторити всі» |
| `apps/web/src/components/Layout.tsx` | індикатор у спільній шапці |
| `apps/web/src/features/pos/POSPage.tsx` | індикатор у темній шапці каси, **ліворуч біля бренду** — видно й на вузькому екрані, без заходу в меню «Ще» |
| `apps/web/src/components/LocalSyncAgent.tsx` | `lastError` більше не викидається: тост через 5 хв безперервних невдач |

**Рішення по UX:** коли все синхронізовано — індикатора **немає взагалі**.
Постійний зелений значок швидко стає фоном, і тоді червоний теж перестають
помічати. Жовтий = «чекає відправки», червоний пульсуючий = «не відправлено».

Тост навмисно не на кожному тику, а після 5 хв поспіль — інакше під час
звичайного обриву звʼязку каса потонула б у тостах.

### Перевірено

```
pnpm verify → exit 0
  тести: web 104 (+6) · desktop 121 (+6) · server 217   = 442
  збірка web-бандла ✅ · збірка desktop + bundle-preload ✅
  нові канали справді в dist/preload.js ✅
```

Перезвірив інваріанти IPC після додавання каналів:
`handlers 179 ↔ preload 179`, каналів без правила доступу — **0**.

Нові тести:
- `apps/desktop/tests/syncStuckRecovery.test.ts` — 6 тестів: listStuck бере лише
  вичерпані; retryStuck скидає лічильник; **не чіпає** тих, хто ще ретраїться;
  вибірковий повтор; порожній список не означає «повторити все»; лічильники в зведенні
- `apps/web/src/components/syncHealthIndicator.test.ts` — 6 тестів: пороги
  severity (`stuck` перебиває `pending`), підписи українською, і що індикатор
  реально вбудований в **обидві** шапки, а `lastError` більше не викидається

### Що лишилось перевірити наживо

Індикатор показується лише в desktop-режимі (`isDesktopRuntime()`), тому в
браузері його не видно за задумом. Живу перевірку робимо після перезбірки exe
в **Ітерації 4** — там же прогін по сценарію: вимкнути інтернет → пробити чек →
переконатися, що зʼявився жовтий значок → увімкнути інтернет → значок зник.
