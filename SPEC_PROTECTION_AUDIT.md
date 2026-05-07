# SPEC: Захист від помилок та лог дій

## Модуль 1: Антидублікат товарів

### Проблема
Один і той самий товар заводиться двічі під різними назвами.
Результат: роздвоєний залишок, плутанина в пошуку, помилки в обліку.

### Логіка перевірки при створенні товару

```
При введенні артикулу:
  normalize(new_article) → шукати в products + product_barcodes + product_supplier_codes
  IF знайдено → показати попередження:

  "⚠️ Можливий дублікат:
   Фільтр Mann W712  |  арт: W712  |  є на складі: 5 шт
   [Це той самий товар — відкрити картку]  [Ні, це інший — продовжити]"

При введенні назви (якщо артикул не знайдено):
  trigram_similarity(new_name, product.name) > 0.7
  → показати список схожих назв для вибору

Перевірка виконується:
  - При ручному створенні товару
  - При імпорті накладної (SPEC_IMPORT_INVOICE.md)
  - При швидкому створенні в POS
```

### Таблиця БД (для зберігання підтверджених "не дублікатів")

```sql
CREATE TABLE product_not_duplicate_pairs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  product_a   UUID NOT NULL REFERENCES products(id),
  product_b   UUID NOT NULL REFERENCES products(id),
  confirmed_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, product_a, product_b)
);
-- Якщо пара є в цій таблиці — більше не попереджати про дублікат
```

---

## Модуль 2: Захист від від'ємного залишку

### Правила

```
РІВЕНЬ 1 — Попередження (дозволяє продати з підтвердженням):
  Залишок = 0, але немає резервів і немає незакритих замовлень
  → Попередити касира: "Товару немає на складі. Продовжити?"
  → Касир може підтвердити (якщо є фізично, просто не провели прихід)

РІВЕНЬ 2 — Блокування (тільки з PIN):
  Залишок < 0 (вже в мінусі)
  → "Залишок від'ємний. Потрібен PIN власника для продажу"
  → Фіксується в audit_log

РІВЕНЬ 3 — Жорстке блокування (ніколи не дозволяти):
  Налаштовується в адмінці: allow_negative_stock = false
  → Продаж неможливий без приходу товару
```

### Налаштування

```sql
ALTER TABLE tenants
  ADD COLUMN allow_negative_stock     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN negative_stock_requires_pin BOOLEAN NOT NULL DEFAULT true;
```

---

## Модуль 3: Лог дій персоналу (Audit Trail)

### Що фіксуємо

```
ОБОВ'ЯЗКОВО (автоматично):
  - Будь-яка зміна ціни товару
  - Знижка нижче мінімальної (+ хто підтвердив PIN)
  - Видалення або анулювання продажу / замовлення / оплати
  - Зміна ролі користувача
  - Зміна балансу клієнта вручну
  - Проведення інвентаризації
  - Ручне коригування залишку
  - Вхід/вихід з системи
  - Зміна налаштувань (PIN, мінімальні ціни, ліміти)

ОПЦІОНАЛЬНО (налаштовується):
  - Кожне відкриття картки клієнта
  - Перегляд закупівельних цін
  - Завантаження звітів
```

### Таблиця БД

```sql
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  user_id       UUID REFERENCES users(id),
  user_name     TEXT NOT NULL,              -- snapshot на момент дії
  action        TEXT NOT NULL,             -- 'price_changed' / 'sale_voided' / ...
  entity_type   TEXT NOT NULL,             -- 'product' / 'sale' / 'customer' / ...
  entity_id     UUID,
  entity_label  TEXT,                      -- назва/номер для зручного читання
  old_value     JSONB,                     -- що було до
  new_value     JSONB,                     -- що стало
  ip_address    INET,
  note          TEXT,                      -- коментар якщо потрібен
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_tenant_created ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at DESC);
```

### Приклади записів

```json
// Зміна ціни
{
  "action": "price_changed",
  "entity_type": "product",
  "entity_label": "Фільтр Mann W712",
  "old_value": { "price_kopecks": 45000 },
  "new_value": { "price_kopecks": 48000 },
  "user_name": "Іванов І."
}

// Знижка нижче мінімуму
{
  "action": "min_price_override",
  "entity_type": "sale_item",
  "entity_label": "Чек #234, Фільтр Mann W712",
  "old_value": { "price_kopecks": 45000, "min_price_kopecks": 30000 },
  "new_value": { "price_kopecks": 25000 },
  "note": "PIN підтверджено власником"
}

// Анулювання продажу
{
  "action": "sale_voided",
  "entity_type": "sale",
  "entity_label": "Чек #234 на 1250 грн",
  "old_value": { "status": "completed" },
  "new_value": { "status": "voided" },
  "note": "Клієнт відмовився"
}
```

### UI: Перегляд логу

```
Лог дій                           Фільтр: [Всі дії ▼] [Всі користувачі ▼] [Сьогодні ▼]

15:42  Іванов І.    Змінено ціну  Фільтр Mann W712  450→480 грн          [Деталі]
15:38  Коваль О.    Анульовано    Чек #234  1250 грн  "клієнт відмовився" [Деталі]
15:12  Іванов І.    Знижка <мін.  Чек #231  Прокладка  PIN підтверджено   [Деталі]
14:55  Коваль О.    Вхід в систему                                         [Деталі]
```

---

## Модуль 4: Звірка каси (детальна логіка)

### Процес закриття зміни

```
1. Касир натискає [Закрити зміну]
2. Система показує:
   Відкрито:      08:00  залишок початку: 500 грн
   Продажів готівкою:    +3 450 грн
   Повернень готівкою:   -150 грн
   Внесень:              +0 грн
   Вилучень:             -500 грн
   ─────────────────────────────
   Розрахункова каса:    3 300 грн

3. Касир вводить фактичну суму: [3 285] грн
4. Розбіжність: -15 грн

5. Якщо розбіжність > допуску (налаштовується, наприклад 10 грн):
   → Обов'язково вказати причину: [_________________]
   → Зафіксувати в audit_log

6. Підтвердити закриття зміни
```

### Таблиця (доповнення до shifts)

```sql
ALTER TABLE shifts
  ADD COLUMN expected_cash_kopecks  INTEGER DEFAULT 0,
  ADD COLUMN actual_cash_kopecks    INTEGER DEFAULT 0,
  ADD COLUMN cash_difference_kopecks INTEGER GENERATED ALWAYS AS
    (actual_cash_kopecks - expected_cash_kopecks) STORED,
  ADD COLUMN cash_difference_note   TEXT,
  ADD COLUMN cash_difference_confirmed_by UUID REFERENCES users(id);
```

---

## Модуль 5: Мертвий стік та уцінка

### Логіка визначення мертвого стіку

```sql
-- Товар вважається "мертвим" якщо:
-- qty > 0 AND остання продажа > N днів тому (або взагалі не було продажів)

CREATE VIEW dead_stock_report AS
SELECT
  p.id,
  p.name,
  p.article,
  p.price_kopecks,
  p.purchase_price_kopecks,
  COALESCE(s.last_sale_date, p.created_at::date) AS last_movement_date,
  CURRENT_DATE - COALESCE(s.last_sale_date, p.created_at::date) AS days_since_last_sale,
  p.price_kopecks * p.qty_in_stock AS stock_value_kopecks
FROM products p
LEFT JOIN (
  SELECT product_id, MAX(created_at::date) AS last_sale_date
  FROM sale_items
  GROUP BY product_id
) s ON s.product_id = p.id
WHERE p.qty_in_stock > 0
  AND p.deleted_at IS NULL
ORDER BY days_since_last_sale DESC;
```

### Функція уцінки (масова)

```
Власник відкриває звіт "Мертвий стік":
  Поріг: [90] днів без продажів

  Артикул       | Залишок | Днів | Ціна зараз | Нова ціна
  Mann W712     |    5    |  120 |  450 грн   | [360____] -20%
  Gates T42073  |    2    |  95  |  280 грн   | [224____] -20%

  [Встановити знижку для всіх: 20% ▼] [Застосувати]
  [Зберегти нові ціни]

Після збереження: кожна зміна ціни фіксується в audit_log
```

### Налаштування

```sql
ALTER TABLE tenants
  ADD COLUMN dead_stock_threshold_days INT NOT NULL DEFAULT 90;
```
