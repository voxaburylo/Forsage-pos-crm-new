import { formatMoney, formatDate } from '@/lib/utils'
import type { CustomerOrder } from './orderApi'

export function printOrderReceipt(order: CustomerOrder, shopName = 'ФОРСАЖ') {
  const customer = order.customer
  const vehicle = order.vehicle_info
  const totalPaid = order.total_paid ?? order.prepayment
  const remaining = Math.max(0, order.total_amount - totalPaid)
  const isFullyPaid = remaining === 0

  const itemsHtml = order.items.map((item, i) => `
    <div style="margin-bottom: 1mm;">
      <div>${i + 1}. ${escapeHtml(item.name)}</div>
      <div style="display: flex; justify-content: space-between; padding-left: 3mm; font-size: 9px;">
        <span>${item.qty} шт × ${formatMoney(item.sell_price)}</span>
        <span style="font-weight: bold;">${formatMoney(item.sell_price * item.qty)}</span>
      </div>
      ${item.sku ? `<div style="font-size: 8px; color: #666; padding-left: 3mm;">Арт: ${escapeHtml(item.sku)}</div>` : ''}
    </div>
  `).join('')

  const printContent = `
    <div class="rp">
      <div class="rp-center rp-bold rp-lg">${escapeHtml(shopName)}</div>
      <div class="rp-center rp-sm">Замовлення автозапчастин</div>
      <hr class="rp-dash" />
      <div>Дата: ${formatDate(order.created_at)}</div>
      ${order.pickup_deadline_at ? `<div>Дедлайн: ${formatDate(order.pickup_deadline_at)}</div>` : ''}
      <hr class="rp-dash" />
      <div class="rp-bold">КЛІЄНТ</div>
      <div>${customer?.full_name ? escapeHtml(customer.full_name) : '—'}</div>
      ${customer?.phone ? `<div>${escapeHtml(customer.phone)}</div>` : ''}
      ${vehicle ? `
        <div style="margin-top: 2mm;" class="rp-bold">АВТОМОБІЛЬ</div>
        <div>${[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')}</div>
        ${vehicle.engine_volume ? `<div>Двигун: ${escapeHtml(vehicle.engine_volume)}</div>` : ''}
        ${vehicle.vin ? `<div>VIN: ${escapeHtml(vehicle.vin)}</div>` : ''}
      ` : ''}
      <hr class="rp-dash" />
      <div class="rp-bold" style="margin-bottom: 1mm;">ДЕТАЛІ</div>
      ${itemsHtml}
      <hr class="rp-dash" />
      <div class="rp-row rp-total">
        <span>ЗАГАЛЬНА СУМА:</span>
        <span>${formatMoney(order.total_amount)}</span>
      </div>
      ${totalPaid > 0 ? `
        <div class="rp-row" style="font-size: 9px; color: #2563eb;">
          <span>Сплачено:</span>
          <span>${formatMoney(totalPaid)}</span>
        </div>
      ` : ''}
      ${remaining > 0 ? `
        <div class="rp-row" style="font-size: 10px;">
          <span>Залишок до сплати:</span>
          <span style="color: #ea580c; font-weight: bold;">${formatMoney(remaining)}</span>
        </div>
      ` : ''}
      ${isFullyPaid ? `
        <div class="rp-center" style="color: #16a34a; font-weight: bold; margin-top: 2mm; font-size: 10px;">
          ✅ ОПЛАЧЕНО ПОВНІСТЮ
        </div>
      ` : ''}
      <hr class="rp-dash" />
      <div class="rp-center rp-sm">З повагою, команда ${escapeHtml(shopName)}</div>
    </div>
  `

  const printWindow = window.open('', '_blank', 'width=400,height=600')
  if (!printWindow) return

  printWindow.document.write(`
    <html>
      <head>
        <title>Квитанція замовлення</title>
        <style>
          @page { margin: 0; size: 58mm auto; }
          body { margin: 0; padding: 0; font-family: monospace; font-size: 10px; }
          .rp { width: 58mm; padding: 2mm 3mm; background: #fff; color: #000; }
          .rp-center { text-align: center; }
          .rp-bold { font-weight: bold; }
          .rp-lg { font-size: 12px; }
          .rp-sm { font-size: 8px; color: #666; }
          .rp-dash { border: none; border-top: 1px dashed #000; margin: 2mm 0; }
          .rp-row { display: flex; justify-content: space-between; }
          .rp-total { font-size: 11px; font-weight: bold; }
          @media print { body { -webkit-print-color-adjust: exact; } }
        </style>
      </head>
      <body>${printContent}</body>
    </html>
  `)
  printWindow.document.close()
  setTimeout(() => { printWindow.print() }, 300)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"')
}
