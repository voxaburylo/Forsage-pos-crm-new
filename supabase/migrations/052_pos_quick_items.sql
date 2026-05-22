-- 052_pos_quick_items.sql
-- Додаємо JSONB колонку для швидких товарів POS (налаштовуються в адмінці)

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS pos_quick_items JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN shop_settings.pos_quick_items IS 'Масив швидких товарів для POS:
[
  {
    "sku": "COFFEE",
    "label": "КАВА",
    "emoji": "☕️",
    "price": 2500,          -- копійки, 0 = з бази
    "color": "#78350F",     -- hex кольору фону
    "children": [           -- підваріанти (випадаюче меню)
      { "label": "Р13", "sku": "CAM-R13", "price": 0 }
    ]
  }
]';
