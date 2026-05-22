# АРХІТЕКТУРНИЙ АУДИТ POS СИСТЕМИ — CRM-FORSAGE

> **Аудитор:** Claude Opus 4.7 (Principal Architect / Staff+ Engineer / CTO Consultant)  
> **Проект:** CRM-Forsage  
> **Документація:** POS_ARCHITECTURE.md + аудит коду (30+ файлів)  
> **Дата:** 2026-05-22  

---

## ЗВЕДЕНИЙ СТАТУС СИСТЕМИ

```
Current maturity: 6.5/10

✅ Що працює добре:
  - Атомарний process_sale RPC з FOR UPDATE
  - Всі суми в копійках (INTEGER) — нема float-помилок
  - Двофазна блокіровка products — нема deadlock
  - Мультивкладочність (до 5 чеків)
  - Crash recovery через localStorage
  - RBAC на рівні ролей
  - Звірка каси перед закриттям зміни

⚠️ Що потрібно виправити (6.5 → 8.0):
  - Ідемпотентність платежу             CRITICAL
  - Подвійне списання бонусів           HIGH
  - process_sale не враховує резерви    HIGH
  - Mock Terminal/ПРРО                  HIGH
  - Suspended чеки без TTL              MEDIUM
  - Нема optimistic locking на клієнті   MEDIUM
  - localStorage без ліміту             LOW
  - Нема офлайн режиму                  MEDIUM
  - Нема WebSocket                       LOW
  - Нема idempotency key                CRITICAL

Target maturity: 9.0/10 (після всіх доробок)
```

---

# ЕТАП 1 — АУДИТ

## 1. FRONTEND (React + Zustand)

| ID | Рівень | Категорія | Опис | Симптоми | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|----------|-----------|
| F-01 | **Critical** | Ідемпотентність | `usePOS.completeSale()` не має idempotency key. Якщо POST /sales відповідає timeout — клієнт передає запит повторно | Касир бачить "помилка", натискає ще раз → дублікат продажу | Подвійне списання товару, подвійний борг, зайва фіскалізація | **P0** |
| F-02 | **High** | Бонуси | Списання бонусів у `usePOS.ts:59-68` відбувається ОКРЕМО від `process_sale` через `api.post('/loyalty/.../redeem')` | Бонуси списуються після створення продажу. Якщо redeem fail → товар продано, бонус не списано | Втрата грошей — клієнт отримує товар без списання бонусів | **P0** |
| F-03 | **High** | UX | PaymentModal не блокує подвійне натискання на "ПІДТВЕРДИТИ". Користувач може натиснути двічі до завершення обробки | `loading` стан є, але клієнт може викликати `handleConfirm` двічі до `setLoading(true)` | Подвійний платіж. Подвійне списання | **P0** |
| F-04 | **Medium** | Координація стану | Zustand store і usePOS мають дублікати логіки. Стан менеджера зберігається і в store, і в сесії | `managerId` в posStore, але також `session.user.id`. Незрозуміло який пріоритет | Комісія нараховується на не того менеджера | **P1** |
| F-05 | **Medium** | Сканування | Barcode scanning у SearchPanel не має пріоритету над debounced search | Касир сканує штрихкод → 200ms затримка → запит. У повільному інтернеті додаткова затримка | Сповільнення касира на 200-500ms за скан | **P2** |
| F-06 | **Low** | Безпека | RBAC перевірка на рівні UI (`canUserDiscount`) — дуже легко обійти | Користувач може надіслати PATCH з discount > 0, і backend її прийме | Зловживання знижками | **P1** |
| F-07 | **Low** | localStorage | `saveCart()` викликається при кожній зміні `store.tabs`. 5 вкладок * 50 позицій → ~50KB. Ліміт localStorage 5MB. Нема перевірки на переповнення | При дуже великих чеках localStorage може впасти | Втрата кошика при збої | **P2** |
| F-08 | **Medium** | Пам'ять | `Recover Cart` банер зберігає великий JSON. Помилка десеріалізації → try { JSON.parse } catch { return null } — тихий fail | Користувач просто втрачає кошик | Втрата даних для клієнта | **P1** |

## 2. BACKEND (Express + TypeScript)

| ID | Рівень | Категорія | Опис | Симптоми | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|----------|-----------|
| B-01 | **Critical** | Ідемпотентність | `POST /api/v1/sales` не має `Idempotency-Key`. Клієнтський timeout → retry → дублікат | Продавець не бачить що продаж створено | Втрата грошей. Подвійне списання товару | **P0** |
| B-02 | **High** | Консистентність | Бонуси списуються в `saleService.createSale()` крок 11-12, але в ОКРЕМИХ RPC. `process_bonus_spend` і `process_bonus_earn` — за транзакцією `process_sale` | Якщо бонус RPC fail → гроші вже продано, бонус не списано | Незбалансовані бонуси | **P0** |
| B-03 | **High** | Інтеграція | `MockBankTerminalService` і `MockPrroService` — замість реального термінала. `processCardPayment()` викликається ПІСЛЯ `process_sale` | Продаж вже зареєстрований, але термінал не підтвердив платіж | Якщо термінал відхиляє — гроші вже продано | **P0** |
| B-04 | **High** | Обробка помилок | Нема `process.on('uncaughtException')` і `process.on('unhandledRejection')` | Будь-яка неперехоплена помилка → SERVER CRASH | POS перестає працювати. Втрата поточних чеків | **P1** |
| B-05 | **Medium** | Сток | `process_sale` використовує `qty_on_hand`, не `qty_available`. Ігнорує резерви (`inventory_reserves`) | POS може продати товар який вже зарезервований в замовленні | Продамо "повітря". Клієнт замовлення приходить → а товару нема | **P1** |
| B-06 | **Medium** | Собівартість | `sale_items` не містить `cost_price`. При розрахунку прибутку використовується поточний `purchase_price` | Звіт "прибуток" може бути неточним, якщо ціна закупівлі змінилася | Керівник бачить неправильний прибуток | **P1** |
| B-07 | **Low** | Аудит | `void logAction(...)` — fire-and-forget. Не блокує відповідь, але audit записує асинхронно | Якщо audit DB fail, продаж продовжується без аудиту | Неможливо відновити дії касира | **P2** |
| B-08 | **Low** | Безпека | `routes/picking.ts` — відсутня `requireRole`. Будь-який аутентифікований користувач може змінювати статус позицій | Зібрані товари може змінити кожен, навіть касир | Порушення бізнес-процесу | **P1** |

## 3. DB (PostgreSQL / Supabase)

| ID | Рівень | Категорія | Опис | Симптоми | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|----------|-----------|
| D-01 | **Critical** | Консистентність | `process_sale` не має idempotency check. Якщо викликати двічі — створить 2 продажі, спише 2 рази товар з qty_on_hand | RPC викликається з боку сервера. Сервер може повторити | ПОДВІЙНЕ СПИСАННЯ ТОВАРУ. НУЛЬОВИЙ ЗАЛИШОК. ВІД'ЄМНИЙ | **P0** |
| D-02 | **High** | Валідація | Нема CHECK constraint на `sys_background_jobs.status`. Можна вставити будь-яке значення | Будь-яка помилка → статус 'processing' → job вважається захопленим і ніколи не виконається | ФОНОВІ ЗАВДАННЯ ВИСЯТЬ НАЗАВЖДИ. Втрата резервів, нечисток | **P0** |
| D-03 | **Medium** | Консистентність | `sys_background_jobs` не має CHECK на `status`. Нема унікального індексу для `(job_type, status)` — неможливо запобігти подвійному enqueue | Дві чи більше однакових задач в черзі | Зайві retry, конфлікт даних | **P1** |
| D-04 | **Low** | Аномалія | `cancel_supply_invoice` використовує `GREATEST(0, ...)` на qty_on_hand. Але `process_writeoff` не має `allow_negative_qty` check | Неможливо зробити списання, якщо власник дозволив від'ємні залишки | Користувач не може зробити те, що дозволено налаштуваннями | **P2** |

## 4. API (Express Routes)

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| A-01 | **Critical** | Ідемпотентність | ПРОДАЖ — нема idempotency key | Подвійний продаж | **P0** |
| A-02 | **Medium** | RBAC | `GET /api/v1/picking/orders` без `requireRole` | Будь-який користувач бачить внутрішню логістику (дані збірок) | **P1** |
| A-03 | **Low** | Чистота | `routes/sales.ts` — маршрути `/suspended` і `/ready-for-pickup` мають бути ДО `/:id`. Потенційно можна забути і воно перетворить "suspended" на аргумент `id` | Express може зматчити `/suspended` як `:id` → 404 | **P2** |

## 5. POS ПОТОКИ

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| P-01 | **Critical** | Платіж | Термінал обробляється ПІСЛЯ `process_sale`. Якщо термінал відхилив — продаж вже в БД | Втрата грошей на суму продажу | **P0** |
| P-02 | **High** | Suspend | Suspended чеки не мають TTL (expires_at). Чеки можуть висіти в статусі 'suspended' навічно | Несписані товари заблоковані у віртуальному сенсі. 100 відкладених чеків → 100 заблокованих корзин | **P1** |
| P-03 | **Medium** | Закриття | Зміну можна не закрити — закрити браузер без закриття зміни. Нема timeout на відкриту зміну | Зміна висить тижнями. Expected cash = поточна. Касир має підсумок за всю зміну але не може її закрити | **P1** |
| P-04 | **Medium** | Звірка | Звірка перед закриттям обов'язкова. Але нема автоматичного нагадування | Касир забув зробити звірку → закриття fail → демотивація | **P2** |

## 6. STORE (Zustand)

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| S-01 | **High** | State consistency | `clearReceipt()` викликає `closeTab()` (закриває вкладку). Але якщо продаж fail на кроках 6-12 (MockTerminal, MockPRRO) — кошик втрачається | КАСИР НЕ МОЖЕ ПЕРЕДАТИ ЧЕК (кошик втрачено) | **P0** |
| S-02 | **Medium** | Multi-tab | При продажі з одної вкладки (multitab) втрачається клієнт і notes. `closeTab()` створює новий чек, але без клієнта/notes | Касир повинен переприв'язати клієнта через пошук. Втрата контексту | **P1** |
| S-03 | **Low** | Пам'ять | Zustand тримає весь стан в пам'яті. Великі чеки (100+ позицій) можуть бути повільними | Потенційне сповільнення при великій кількості позицій | **P3** |

## 7. UX КАСИРА

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| U-01 | **Medium** | Зворотній зв'язок | Після оплати немає зрозумілого зворотнього зв'язку, чи чек надруковано/не надруковано. `printReceipt()` — тихий fail, якщо браузер блокує спливаюче вікно | Касир не бачить, чи чек надруковано | **P1** |
| U-02 | **Low** | Клавіші | Нема хоткею "вибрати кліента" на кшталт F2 (пошук). Касир мусить мишкою натискати "+ Клієнт" | Зайвий рух мишкою. Кілька секунд на чек | **P2** |
| U-03 | **Medium** | Відновлення | Банер "Знайдено збережений кошик" не відображає вміст — касир не знає, що відновлює | Касир може відхилити відновлення, бо не бачить вміст | **P1** |
| U-04 | **Low** | Hotkeys | Нема постійних підказок hotkeys для касира (окрім HelpModal по F1). Нові касири не знають про F-key | Зниження швидкості нових касирів на 2-3 тижні | **P2** |

## 8. RECOVERY

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| R-01 | **Medium** | LocalStorage | `saveCart()` зберігає весь кошик, але НЕ зберігає shift_id. Після відновлення shift_id може бути недійсним (якщо зміну закрили) | Shift ID не належний → продаж fail | **P1** |
| R-02 | **Low** | Crash | Якщо браузер впав під час `process_sale` → сервер створив sale, але клієнт не отримав відповідь. Нема retry механізму для перевірки статусу | Продаж є в БД, але кошик ще в локальному storage. Касир втрачає що продав | **P1** |
| R-03 | **Low** | Backup | Нема автоматичного backup даних перед оновленням. Аудит є, але без нього завжди можна відкатити | Втрата даних при збої | **P2** |

## 9. PERFORMANCE

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| C-01 | **Low** | Пошук | `GET /api/v1/products?search=` — кожен символ → debounced 200ms → запит. Без індексу на `search` — довгий | При 5 товарах — швидко. При 50k — сповільнення до 1-3с | **P2** |
| C-02 | **Low** | Jobs | JobWorker.poll() має рекурсію (баг) — при 10k pending jobs можливий стековерфлоу | Сервер крашиться? Відновлення? | **P1** |
| C-03 | **Low** | SQL | `reportService.ts` — 2 SQL запити (sale → items) + JS групування. Можна одним GROUP BY | Додатковий 1 round-trip на кожен звіт | **P3** |

## 10. БЕЗПЕКА

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| X-01 | **Medium** | RBAC client | Discount check `if (role && !['owner','admin','manager'].includes(role)) return` на клієнті. БЕКЕНД НЕ ПЕРЕВІРЯЄ | Касир може встановити знижку 100% через devtools | ЗБИТКИ | **P0** |
| X-02 | **Low** | RBAC missing | `routes/picking.ts` без `requireRole` — будь-який аутентифікований користувач має доступ | Потенційне вилучення інвентарних даних | **P1** |
| X-03 | **Low** | Audit trail | `void logAction` — не б'є відповідь, не логує audit. Нема гарантії доставки аудиту | Неможливо відновити хронологічний аудит. Потрібно впровадити sync audit | **P2** |

## 11. НАДІЙНІСТЬ

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| N-01 | **Medium** | Graceful shutdown | Нема `process.on('uncaughtException')`. Сервер може впасти в будь-який момент | Касова система стоїть, касири не продають | **P0** |
| N-02 | **Medium** | Консистентність | Бонуси (+/-) викликаються ОКРЕМО від process_sale. Немає єдиної транзакції на "продаж + бонуси" | Можлива неконсистентність між продажем і бонусами | **P1** |

## 12. ТЕХНІЧНИЙ БОРГ

| ID | Рівень | Категорія | Опис | Наслідки | Пріоритет |
|----|--------|-----------|------|----------|-----------|
| T-01 | **Medium** | Застарілий код | `process_sale` версії в 4-х файлах міграцій (019, 021, 025, 031). Нема DROP старої | Можливо стосуються партійних перевірок, але створюють інформаційний шум | **P2** |
| T-02 | **Low** | Tenant ID hardcode | `TENANT_ID = '00000000-0000-0000-0000-000000000001'` в 5+ сервісах | Перешкоджає масштабуванню | **P3** |
| T-03 | **Low** | RPC дублікація | `process_sale` логіка (FOR UPD + перевірка + insert + update) — повторюється в `process_internal_consumption`, `process_writeoff` | Багато коду, який потрібно тримати в голові при змінах | **P2** |

---

# ЕТАП 2 — ПЕРЕВІРКА ПОТОКІВ

## 2.1 Відкриття зміни

**Flow:** OpenShiftScreen → `POST /shifts/open` → INSERT shift

**Ризики:**
- ✅ Існує: перевірка на вже відкриту зміну (409 SHIFT_ALREADY_OPEN)
- ⚠️ Середній: неперервно відкриті зміни (касир закрив браузер)
- ⚠️ Низький: нема змінного звіту в реальному часі

**Блокування:** Нема

**Втрата даних:** Нема

**Покращення:**
- Авто-закриття зміни через N годин неактивності
- Scheduled job: `close_stale_shifts` кожен день

## 2.2 Пошук товару

**Flow:** SearchPanel → debounce 200ms → GET /api/v1/products → відображення → Enter → store.addItem()

**Ризики:**
- ✅ Добре: debounce, клавіші F2
- ✅ Добре: камерне сканування
- ⚠️ Низький: поверхневий debounce не відрізняє скан від тексту
- ⚠️ Низький: qty_available не передається в SearchPanel (на клієнті показується qty_on_hand)

**Блокування:** Інтернет (поява fail → товари не знайдено)

**Втрата даних:** Нема

**Покращення:**
- Окремий handler для сканера (без debounce)
- Клієнтський кеш товарів (для жорсткого офлайну)

## 2.3 Кошик (ReceiptPanel)

**Flow:** items[] → calcTotals() → відображення → total

**Ризики:**
- ✅ Добре: рахування subtotal, totalDiscount, total на клієнті в `calcTotals()`
- ✅ Добре: qtyOnHand перевірка
- ✅ Добре: localStorage autosave
- ⚠️ Середній: кошик `selectedProductId` зберігається в Zustand але не відновлюється з localStorage

**Блокування:** Нема (всередині клієнта)

**Втрата даних:** Локальні, якщо localStorage переповниться (F-07)

## 2.4 Редагування чека

**Flow:** +/- qty → numpad → updateQty → removeItem → discount

**Ризики:**
- ✅ Добре: +/- перевірка на qtyOnHand
- ✅ Добре: numpad для точного введення
- ⚠️ Середній: знижка Є на фронті, але нема перевірки discount на бекенді
- ⚠️ Низький: `toFixed(3)` може дати абсолютні помилки накопичення (0.1+0.2=0.30000000000000004)

**Покращення:**
- Замінити `toFixed(3)` на `Math.round(qty * 1000) / 1000`

## 2.5 Оплата (PaymentModal)

**Flow:** PaymentModal → method → cashInput → bonusInput → confirm → usePOS.completeSale() → POST /sales

**Ризики:**
- ❌ **Critical:** БЕЗ Idempotency-Key
- ❌ **Critical:** Бонуси списання ОКРЕМО (F-02)
- ❌ **Critical:** Подвійне натискання (F-03)
- ✅ Добре: 5 методів, розділені суми
- ⚠️ Середній: фіскалізація — MockPRRO (повне відключення реального прро)
- ⚠️ Середній: Terminal mock — 2с затримка, 0 реальної перевірки

**Блокування:** Інтернет (весь чек не збережено)

**Втрата даних:** ПОТЕНЦІЙНА (див. дублікати)

## 2.6 Продаж (POST /api/v1/sales)

**Flow:** saleService.createSale() → getCurrentShift → validate → process_sale RPC → MockTerminal → MockPRRO → bonus

**Ризики:**
- ❌ Critical: Terminal/ПРРО після process_sale
- ❌ Critical: Нема idempotency key на вході
- ⚠️ High: Бонуси пост-процес
- ✅ Добре: FOR UPDATE блокування
- ✅ Добре: Валідація shift на сервері

**Блокування:** Будь-яка DB помилка → rollback → клієнт не знає

**Втрата даних:** Нема DB (атомарно), є потенційна надлишковість (дублікати)

## 2.7 Повернення

**Flow:** ReturnForm → POST /api/returns → process_return RPC

**Ризики:**
- ✅ Не вивчалося в цей аудит, але повинен бути атомарним

## 2.8 Борг

**Flow:** PaymentModal → method='debt' → POST /sales → process_sale → UPDATE customers.debt_balance

**Ризики:**
- ⚠️ Середній: debt_balance ні в собі ще не зважений (людина йде продавати знову)
- ✅ Добре: вимагає клієнта
- ⚠️ Середній: Нема credit limit check (можна продати на 100k без ліміту)

**Блокування:** Клієнт обов'язковий

**Покращення:**
- `shop_settings.max_debt_limit` → перевірка в process_sale для debt

## 2.9 Відкладений чек (Suspend)

**Flow:** SuspendModal → saleApi.suspend() → INSERT sales (status='suspended') → sale_items

**Ризики:**
- ⚠️ Середній: TTL на відкладені чеки відсутній
- ⚠️ Середній: Suspended чеки не lockають товар (не списують qty_on_hand, не резервують)
- ✅ Добре: не блокує сток
- ⚠️ Low: sale_number генерується як 'S-' + timestamp. Не гарантує унікальність при навантаженні

**Блокування:** Нема

**Покращення:**
- Додати expires_at на відкладені чеки → scheduled job
- Використовувати sequence для suspension number

## 2.10 Закриття зміни

**Flow:** shiftClose → перевірка reconciliation → розрахунок expected → varians → UPDATE shift

**Ризики:**
- ✅ Добре: Звірка ОБОВ'ЯЗКОВА перед закриттям
- ⚠️ Середній: Розрахунок expected — SQL збирається вручну (можлива помилка)

**Блокування:** Reconciliation absence

**Покращення:**
- Авто-розрахунок expected в один SQL запит (GROUP BY)

## 2.11 Друк

**Flow:** receipt → ReceiptPrint → window.print()

**Ризики:**
- ⚠️ Середній: Браузер блокує спливні вікна — тихий fail без повідомлення
- ⚠️ Low: Нема центру друку (queue, retry, status)
- ✅ Добре: HTML-to-print, A5 portrait

**Блокування:** Adblock/браузерна політика

**Втрата даних:** Тихий fail

## 2.12 Відновлення після збою

**Flow:** Browser → POSPage → loadCart() → банер → restore/dismiss → addItems

**Ризики:**
- ⚠️ Середній: localStorage не зберігає shift_id
- ⚠️ Низький: client-side 'неактивний' shift → продаж 400
- ⚠️ Низький: "Знайдено збережений кошик" не показує що всередині

**Покращення:**
- Додати shift_id до кошика
- Preview кошика перед відновленням

---

# ЕТАП 3 — ROADMAP

## PHASE 0 — STOP LOSSES (P0)

Не допустити втрати грошей.

| ID | Назва | Мета | Файли | Ризик | Складність | Час |
|----|-------|------|-------|-------|-----------|------|
| **PL-01** | Idempotency Key | Запобігти подвійному продажу | `saleService.ts`, `routes/sales.ts`, додати `idempotency_keys` таблицю | ❌ CRITICAL | S | 4 год |
| **PL-02** | Bonus atomicity | Перенести бонуси ВСЕРЕДИНУ process_sale | `process_sale`, `saleService.ts` | ❌ CRITICAL | M | 1 день |
| **PL-03** | Double-click guard | Захист на фронті від подвійного кліку | `PaymentModal.tsx`, `usePOS.ts` | 🔴 HIGH | XS | 2 год |
| **PL-04** | Terminal before sale | Термінал ПІДТВЕРДЖУЄ → process_sale | `saleService.ts`, `MockBankTerminalService.ts` | 🔴 HIGH | M | 1 день |
| **PL-05** | Server uncaughtException | Не дати серверу власти | `server/src/index.ts` | 🔴 HIGH | XS | 30 хв |
| **PL-06** | RBAC discount on backend | Перевірка discount на БЕКЕНДІ | `routes/sales.ts` validator | 🟡 MEDIUM | XS | 1 год |

**Phase 0 total:** ~3.5 дні (реальних)

## PHASE 1 — STABILIZATION (P1)

Довести до стабільності.

| ID | Назва | Мета | Файли | Ризик | Складність | Час |
|----|-------|------|-------|-------|-----------|------|
| **PL-07** | process_sale v2 | Враховувати qty_available | `064_inventory_reserves.sql`, `saleService.ts` | 🔴 HIGH | L | 2 дні |
| **PL-08** | JobWorker poll fix | Виправити рекурсію | `jobWorker.ts` | 🟡 MEDIUM | XS | 30 хв |
| **PL-09** | sys_bg_jobs CHECK | Додати CHECK на status | migration 067 | 🟢 LOW | XS | 30 хв |
| **PL-10** | Suspended TTL | Додати expires_at на suspend чеки | `supabase/migrations`, `SuspendModal.tsx` | 🟡 MEDIUM | S | 4 год |
| **PL-11** | Cash reconciliation reminder | Нагадування касиру перед закриттям | `ShiftCloseModal.tsx` | 🟢 LOW | XS | 1 год |
| **PL-12** | LocalStorage shift_id | Додати shift_id до кошика | `POSPage.tsx` (saveCart/loadCart) | 🟢 LOW | XS | 30 хв |
| **PL-13** | Graceful shutdown | uncaughtException + unhandledRejection | `server/src/index.ts` | 🟡 MEDIUM | XS | 1 год |
| **PL-14** | Picking RBAC | Додати requireRole | `routes/picking.ts` | 🟢 LOW | XS | 15 хв |
| **PL-15** | Suspended number sequence | Використовувати seq для suspend чеків | `supabase/migrations` | 🟢 LOW | S | 2 год |
| **PL-16** | Expired reserves check | Впевнитись, що резерви очищаються | `ReserveService.ts` | 🟡 MEDIUM | XS | 1 год |

**Phase 1 total:** ~5 днів

## PHASE 2 — SPEED (P2)

Прискорити касира.

| ID | Назва | Мета | Файли | Ризик | Складність | Час |
|----|-------|------|-------|-------|-----------|------|
| **PL-17** | Barcode priority | Окремий handler для сканування (без debounce) | `SearchPanel.tsx` | 🟢 LOW | XS | 1 год |
| **PL-18** | Product search FTS Index | Додати full-text search індекс на products | `supabase/migrations` | 🟢 LOW | S | 2 год |
| **PL-19** | Hotkeys cheat sheet | Екран швидкої довідки на головній | `POSPage.tsx` (always-visible mini bar) | 🟢 LOW | M | 4 год |
| **PL-20** | Quick-customer hotkey | F4 → вибір клієнта | `POSPage.tsx`, `ReceiptPanel.tsx` | 🟢 LOW | XS | 1 год |
| **PL-21** | Recover cart preview | Показати вміст перед відновленням | `POSPage.tsx` | 🟢 LOW | S | 3 год |
| **PL-22** | Audit sync (blocking) | Аудиторія синхронно | `auditService.ts` | 🟢 LOW | S | 3 год |

**Phase 2 total:** ~4 дні

## PHASE 3 — RELIABILITY (P3)

Відмовостійкість.

| ID | Назва | Мета | Файли | Ризик | Складність | Час |
|----|-------|------|-------|-------|-----------|------|
| **PL-23** | Offline mode | Service Worker + IndexedDB для товарів | `server/sw.ts`, `productApi.ts` | 🟡 MEDIUM | XL | 2 тиж |
| **PL-24** | Stale shift autoclose | Scheduled job: close_stale_shifts | `workers/jobWorker.ts`, handler | 🟢 LOW | M | 4 год |
| **PL-25** | Check status after crash | Endpoint /api/v1/sales/check-after-payment | `routes/sales.ts` | 🟢 LOW | M | 4 год |
| **PL-26** | POS heartbeat | Періодичний ping на сервер | `POSPage.tsx` WebSocket | 🟢 LOW | S | 2 год |
| **PL-27** | Graceful DB reconnect | Повідомити касира про DB disconnect | `db/supabase.ts` | 🟡 MEDIUM | S | 3 год |
| **PL-28** | Реальний термінал | Agent + API для реального еквайрингу | new integration module | 🔴 HIGH | XL | 2-4 тиж |
| **PL-29** | Реальний ПРРО | API для реального фіскалізатора | new integration module | 🔴 HIGH | XL | 2-4 тиж |

**Phase 3 total:** ~4-8 тижнів (прогресивно)

## PHASE 4 — SCALE (P4)

Масштабування.

| ID | Назва | Мета | Файли | Ризик | Час |
|----|-------|------|-------|-------|------|
| **PL-30** | TenantId dynamic | Прибрати hardcoded TENANT_ID | `services/*.ts` | 🟡 MEDIUM | 2 дні |
| **PL-31** | Product cache | Redis/Memcache/PostgREST cache для каталогу | `server/src/cache/` | 🟢 LOW | 1 день |
| **PL-32** | Read replicas | Postgres читання з репліки | `db/supabase.ts` | 🟡 MEDIUM | 1 день |
| **PL-33** | Background job priority | Priority field + queue reorder | `sys_background_jobs` | 🟢 LOW | 1 день |

**Phase 4 total:** ~5 днів

## PHASE 5 — ENTERPRISE (P5)

Enterprise-функціонал.

| ID | Назва | Мета | Ризик | Час |
|----|-------|------|-------|------|
| PL-34 | Multi-store | Справжній multi-tenant (tenant_id = org) | 🟡 MEDIUM | 2-3 тиж |
| PL-35 | Mobile POS | React Native / PWA | 🟢 LOW | 4-6 тиж |
| PL-36 | Offline sync engine | АВТОСинх синх продажів + конфлікт резолвери | 🟡 MEDIUM | 2-3 тиж |
| PL-37 | WebSocket real-time | Статуси чеків, badge оновлення в реальному часі | 🟢 LOW | 3-5 днів |
| PL-38 | Event bus | Всі бізнес-події в один потік (sale.created, shift.closed, etc.) | 🟡 MEDIUM | 5-7 днів |

---

# ШВИДКІ ПЕРЕМОГИ (2 години – 1 день)

**Що можна зробити за 2 години:**

| Годин | Задача | Ефект |
|-------|--------|-------|
| 2 | Idempotency Key на `POST /sales` | ЗАПОБІГАННЯ подвійному продажу (CRITICAL) |
| 2 | Double-click guard у PaymentModal | ЗАПОБІГАННЯ подвійній оплаті (HIGH) |
| 1 | uncaughtException handler | НЕМАє серверного crash (HIGH) |
| 1 | RBAC discount на бекенді | ЗАПОБІГАННЯ зловживанням (MEDIUM) |
| 0.5 | JobWorker.poll() → setImmediate | ВИПРАВЛЕННЯ рекурсії (MEDIUM) |
| 0.5 | CHECK на sys_background_jobs.status | ДАНИХ консистентність (MEDIUM) |
| 0.5 | requireRole на picking.ts | RBAC missing fix (LOW) |
| 1 | suspended expire_at reminder | Чистота suspend чеків (MEDIUM) |
| 0.5 | localStorage shift_id | Recovery improvement (LOW) |

**За 1 день:** Прибрати 6 з 8 багів Phase 0.

---

# НЕ РОБИТИ (щоб не нашкодити)

Список рішень, які виглядають красиво, але зараз зашкодять проекту:

1. **НЕ переписувати `process_sale`.** ВІН ПРАЦЮЄ. Потрібна `_v2`, не переписування. Просто додати новий RPC, замінити виклик.

2. **НЕ виносити POS в окремий сервіс.** Мікросервіс для однієї каси — перевага нуль, складність — deploy, DB, auth, monitoring. Моноліт простіший.

3. **НЕ додавати GraphQL.** Потрібно простіше: PostgREST вводить REST на рівні БД. GraphQL додасть складність без сильного виграшу для POS.

4. **НЕ додавати React Query, Redux чи MobX.** Zustand створено спеціально для каси. ВСЕ, що потрібно — це ORM-to-request tool. Zustand + api.ts = мінімальна зв'язка.

5. **НЕ виправляти toFixed(3) через BigDecimal.** F-07 — теоретична проблема. Проста дія: `+(value * 1000).toFixed(0) / 1000` — безкоштовно.

6. **НЕ виправляти все в один спринт.** Критичні (Phase 0) в першу чергу. Потім стабільність. Потім швидкість. Не намагатись все в одному етапі.

7. **НЕ WebSocket замість polling в Sidebar.** 2-хвилинний polling — ЦЕ OK для бейджів. WebSocket — це "колись потім".

8. **НЕ Redis для cache замість Postgres.** Мінімальний ефект для POS. Швидше `Partial Index on products(is_active, search)`.

9. **НЕ робити load testing.** Потрібно або 50 клієнтів одночасно. Якщо нема → load test не варто зараз.

10. **НЕ Mobile-first.** POS на 10" Android/Windows — це та ж архітектура. Mobile-first потрібен тільки коли є мобільний касир.

---

# MASTER PLAN

## КРИТИЧНИЙ ШЛЯХ

```
Phase 0 (STOP LOSSES) ─ 3.5 дні
├── PL-01 Idempotency Key (4h) ← CRITICAL PATH START
├── PL-04 Terminal before sale (1d) ← BLOCKER
├── PL-02 Bonus atomicity (1d) ← BLOCKER
└── PL-03/05/06 (3.5h) ← SHARE
    │
    ▼
Phase 1 (STABILIZATION) ─ 5 днів
├── PL-08/09/13/14 (2h) ← ШВИДКО
├── PL-07 process_sale v2 ← MAIN BLOCKER
├── PL-10/15 Suspended TTL + seq
└── PL-11/12/16 (2.5h)
    │
    ▼
Phase 2 (SPEED) ─ 4 дні
├── PL-17/18 Barcode + FTS ← PERFORMANCE
├── PL-19/20 Hotkeys + Quick-Customer ← UX
├── PL-21 Recover cart ← RELIABILITY
└── PL-22 Audit sync
    │
    ▼
Phase 3 (RELIABILITY) ─ 4-8 тижнів
├── PL-23 Offline mode ← MAIN FEATURE
├── PL-28 Реальний термінал ← MUST FOR PROD
├── PL-29 Реальний ПРРО ← MUST FOR PROD
├── PL-24/25/26/27 (enablers)
    │
    ▼
Phase 4 (SCALE) ─ 5 днів
└── PL-30/31/32/33
    │
    ▼
Phase 5 (ENTERPRISE) ─ ongoing
└── PL-34/35/36/37/38
```

## MASTER CHECKLIST

```
Phase 0 — STOP LOSSES (t=0..3.5d)
☐ PL-01 Idempotency Key         [4h]  ← НЕГАЙНО
☐ PL-02 Bonus atomicity          [8h]  ← НЕГАЙНО
☐ PL-03 Double-click guard        [2h]  ← НЕГАЙНО
☐ PL-04 Terminal before sale     [8h]  ← НЕГАЙНО
☐ PL-05 uncaughtException       [0.5h] ← НЕГАЙНО
☐ PL-06 RBAC discount backend   [1h]  ← НЕГАЙНО

Phase 1 — STABILIZATION (t=3.5..8.5d)
☐ PL-07 process_sale v2          [2d]
☐ PL-08 JobWorker poll fix       [0.5h]
☐ PL-09 sys_bg_jobs CHECK        [0.5h]
☐ PL-10 Suspended TTL           [4h]
☐ PL-11 Reconcile reminder      [1h]
☐ PL-12 localStorage shift_id   [0.5h]
☐ PL-13 Graceful shutdown       [1h]
☐ PL-14 Picking RBAC           [0.25h]
☐ PL-15 Suspended seq           [2h]
☐ PL-16 Expired reserves check  [1h]

Phase 2 — SPEED (t=8.5..12.5d)
☐ PL-17 Barcode priority        [1h]
☐ PL-18 Product FTS index        [2h]
☐ PL-19 Hotkeys cheat sheet      [4h]
☐ PL-20 Quick-customer           [1h]
☐ PL-21 Recover preview          [3h]
☐ PL-22 Audit sync              [3h]

Phase 3 — RELIABILITY
☐ PL-23 Offline mode           [2w]
☐ PL-24 Stale shift autoclose   [4h]
☐ PL-25 Check after crash       [4h]
☐ PL-26 POS heartbeat           [2h]
☐ PL-27 Graceful disconn        [3h]
☐ PL-28 Реальний термінал      [2-4w]
☐ PL-29 Реальний ПРРО          [2-4w]

Phase 4 — SCALE
☐ PL-30 Dynamic tenant          [2d]
☐ PL-31 Product cache           [1d]
☐ PL-32 Read replicas           [1d]
☐ PL-33 Job priority            [1d]

Phase 5 — ENTERPRISE
☐ PL-34 Multi-store             [2-3w]
☐ PL-35 Mobile POS              [4-6w]
☐ PL-36 Offline sync engine     [2-3w]
☐ PL-37 WebSocket               [3-5d]
☐ PL-38 Event bus               [5-7d]
```

## DEPENDENCY GRAPH

```
PL-01 ──→ PL-02 ──→ PL-04 ──→ PL-07 ──→ PL-10 ──→ PL-15
  │        │         │          │         │         │
  │        │         │          │         │         │
  ▼        ▼         ▼          ▼         ▼         ▼
PL-03    PL-05     PL-06     PL-08    PL-09     PL-11
                                        │
                                        │
                                        ▼
                                      PL-12
                                        │
                                        ▼
                                      PL-13
                                        │
                                        ▼
                                      PL-14
                                        │
                                        ▼
                                      PL-16

Phase 2 (independent)
PL-17 ──→ PL-20
PL-18    PL-19 ──→ PL-21
                  PL-22

Phase 3 (interdependent)
PL-28 ──→ PL-23 ──→ PL-26 ──→ PL-27
PL-29         │
              ▼
            PL-24 ──→ PL-25

Phase 4 (independent within)
PL-30 ──→ PL-31
PL-32 ──→ PL-33
```

---

# ПІДСУМОК

**Поточна зрілість: 6,5/10 → Ціль: 9,0/10**

**Критичні проблеми (втрата грошей):**
1. Ідемпотентність — 100% подвійний продаж
2. Бонуси атомарність — подвійне списання / втрачені бонуси
3. Термінал після продажу — реалізований продаж без реального платежу
4. RBAC знижки — потенційна крадіжка

**Що робити перші 3 дні:**
- День 1: Idempotency Key + Double-click guard + uncaughtException + RBAC discount
- День 2: Bonus atomicity (перенести до process_sale)
- День 3: Terminal before process_sale + job poll fix

**Економічний ефект:**
- Запобігання подвійному продажу: безцінно (0 критичних)
- Запобігання подвійному бонусу: безцінно (економія на зайвій емісії)
- Стабільність POS: нема серверних аварій → нема втрати кошиків
- RBAC знижки: нема крадіжок 100% знижки → кілька % на місяць

---
*Кінець аудиту. 38 PL-об'єктів, 12 потоків, 5 фаз, 10 не робити, 10 short-term wins.*
