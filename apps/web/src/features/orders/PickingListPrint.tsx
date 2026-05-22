import { formatDate } from '@/lib/utils'
import type { EnrichedCustomerOrder, EnrichedOrderItem } from '@/features/inventory/pickingApi'

export function printPickingList(order: EnrichedCustomerOrder, shopName = 'ФОРСАЖ') {
  // Групуємо товари за ячейками зберігання
  const groups: Record<string, EnrichedOrderItem[]> = {}

  order.items.forEach(item => {
    let key = ''
    if (item.source_type === 'supplier') {
      key = 'Під замовлення (Постачальник)'
    } else {
      key = item.storage_bin ? `Ячейка: ${item.storage_bin}` : 'Без ячейки (Склад)'
    }

    if (!groups[key]) {
      groups[key] = []
    }
    groups[key].push(item)
  })

  const groupsHtml = Object.entries(groups).map(([groupName, items]) => {
    const itemsHtml = items.map((item) => `
      <div style="margin-bottom: 2.5mm; display: flex; align-items: flex-start;">
        <div style="width: 5mm; height: 5mm; border: 1px solid #000; margin-right: 2.5mm; flex-shrink: 0; text-align: center; line-height: 4.5mm; font-weight: bold; font-size: 10px;">
          ${item.item_status === 'arrived' || item.item_status === 'handed' ? '✓' : ''}
        </div>
        <div style="flex-grow: 1;">
          <div style="font-weight: bold; font-size: 11px;">${escapeHtml(item.name)}</div>
          <div style="font-size: 9px; color: #555; display: flex; justify-content: space-between; margin-top: 0.5mm;">
            <span>К-сть: <strong>${item.qty} шт</strong></span>
            ${item.sku ? `<span>Арт: <strong>${escapeHtml(item.sku)}</strong></span>` : ''}
          </div>
        </div>
      </div>
    `).join('')

    return `
      <div style="margin-bottom: 4mm;">
        <div style="background: #eee; padding: 1mm 2mm; font-weight: bold; font-size: 11px; margin-bottom: 2mm; border-left: 3px solid #000;">
          ${escapeHtml(groupName)}
        </div>
        <div style="padding-left: 1mm;">
          ${itemsHtml}
        </div>
      </div>
    `
  }).join('')

  const printContent = `
    <div class="picking-slip">
      <div style="text-align: center; font-weight: bold; font-size: 14px; margin-bottom: 1mm;">
        СБОРКОВИЙ ЛИСТ
      </div>
      <div style="text-align: center; font-size: 10px; color: #555; margin-bottom: 3mm;">
        Магазин: ${escapeHtml(shopName)}
      </div>
      <hr style="border: none; border-top: 1px dashed #000; margin: 2mm 0;" />
      
      <div style="font-size: 10px; line-height: 1.4; margin-bottom: 3mm;">
        <div><strong>Замовлення:</strong> #${order.id.slice(0, 8)}</div>
        ${order.kp_number ? `<div><strong>КП:</strong> ${escapeHtml(order.kp_number)}</div>` : ''}
        <div><strong>Дата замовлення:</strong> ${formatDate(order.created_at)}</div>
        ${order.customer ? `<div><strong>Клієнт:</strong> ${escapeHtml(order.customer.full_name || '')} (${escapeHtml(order.customer.phone)})</div>` : ''}
        ${order.comment ? `<div style="margin-top: 1.5mm; font-style: italic; background: #fafafa; padding: 1.5mm; border: 1px solid #ddd;">Коментар: ${escapeHtml(order.comment)}</div>` : ''}
      </div>
      
      <hr style="border: none; border-top: 1px dashed #000; margin: 2mm 0 4mm 0;" />
      
      <div class="groups-container">
        ${groupsHtml}
      </div>
      
      <hr style="border: none; border-top: 1px dashed #000; margin: 4mm 0 2mm 0;" />
      <div style="text-align: center; font-size: 9px; color: #777; margin-top: 3mm;">
        Збірку завершено: ____ / ____ / 202__ р. Підпис: _________
      </div>
    </div>
  `

  const printWindow = window.open('', '_blank', 'width=500,height=700')
  if (!printWindow) return

  printWindow.document.write(`
    <html>
      <head>
        <title>Збірочний лист замовлення #${order.id.slice(0, 8)}</title>
        <style>
          @page { margin: 5mm; size: A5 portrait; }
          body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 10px; color: #000; background: #fff; }
          .picking-slip { width: 100%; max-width: 140mm; margin: 0 auto; }
          @media print { 
            body { -webkit-print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>${printContent}</body>
    </html>
  `)
  printWindow.document.close()
  setTimeout(() => { printWindow.print() }, 300)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
