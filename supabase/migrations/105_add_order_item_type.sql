-- Migration 105: Тип позиції замовлення товар/робота (ORD-24)
-- Впливає на склад і фіскалізацію: 'service' (робота) не резервується на складі.

ALTER TABLE customer_order_items
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'product'
        CHECK (item_type IN ('product', 'service'));
