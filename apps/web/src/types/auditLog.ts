export interface AuditLog {
  id:           string
  user_id:      string
  user_name:    string
  action:       string
  entity_type:  string
  entity_id:    string | null
  entity_label: string | null
  old_value:    Record<string, unknown> | null
  new_value:    Record<string, unknown> | null
  note:         string | null
  created_at:   string
}

export interface PaginatedAuditLog {
  data:       AuditLog[]
  pagination: { page: number; per_page: number; total: number; total_pages: number }
}

export const ACTION_LABEL: Record<string, string> = {
  'sale.created':          'Продаж',
  'sale.returned':         'Повернення',
  'product.price_changed': 'Зміна ціни',
  'writeoff.created':      'Списання',
  order_created:                  'Створено замовлення',
  order_created_from_draft:       'Чернетку перетворено',
  order_draft_updated:            'Змінено чернетку',
  order_updated:                  'Змінено замовлення',
  order_status_changed:           'Змінено статус',
  order_item_status_changed:      'Змінено позицію',
  order_payment_added:            'Додано оплату',
  order_completed:                'Замовлення видано',
  order_canceled:                 'Замовлення скасовано',
  order_items_bulk_arrived:       'Товар прибув',
  order_sent_to_telegram:         'Надіслано в Telegram',
  order_deleted:                  'Замовлення видалено',
}

export const ACTION_COLOR: Record<string, string> = {
  'sale.created':          'green',
  'sale.returned':         'orange',
  'product.price_changed': 'blue',
  'writeoff.created':      'red',
  order_created:                  'green',
  order_created_from_draft:       'green',
  order_draft_updated:            'blue',
  order_updated:                  'blue',
  order_status_changed:           'blue',
  order_item_status_changed:      'blue',
  order_payment_added:            'green',
  order_completed:                'green',
  order_canceled:                 'orange',
  order_items_bulk_arrived:       'green',
  order_sent_to_telegram:         'blue',
  order_deleted:                  'red',
}
