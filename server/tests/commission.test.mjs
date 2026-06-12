// Тест money-логіки комісії (чиста функція computeCommissionMap) — без БД, без прод.
// Доводить модель «кожен за свої категорії» + базу для сторно повернень.
import { computeCommissionMap } from '../dist/services/commissionService.js'

let failed = 0
const check = (n, c, x='') => { console.log(`${c?'  PASS':'  FAIL'} ${n} ${c?'':x}`); if(!c) failed++ }

const COFFEE='cat-coffee', PARTS='cat-parts', OTHER='cat-other'
const COFFEE_MGR='u-coffee', PARTS_MGR='u-parts', CASHIER='u-cashier'

const productsMap = {
  pCoffee: { brand_id:null, category_id: COFFEE },
  pParts:  { brand_id:null, category_id: PARTS },
  pOther:  { brand_id:null, category_id: OTHER },
}
const rules = [
  { user_id: COFFEE_MGR, category_id: COFFEE, brand_id:null, rule_type:'total_cashbox', pct_from_revenue:10, pct_from_profit:0 },
  { user_id: PARTS_MGR,  category_id: PARTS,  brand_id:null, rule_type:'total_cashbox', pct_from_revenue:5,  pct_from_profit:0 },
  { user_id: null,       category_id:null,    brand_id:null, rule_type:'personal_sales', pct_from_revenue:2, pct_from_profit:0 },
]

// A. Продаж кави касиром (касир — активний продавець, не власник категорії)
let m = computeCommissionMap([{ product_id:'pCoffee', sell_price:10000, buy_price:5000, qty:1 }], productsMap, rules, CASHIER)
check('A: менеджеру кави 10% = 1000', m.get(COFFEE_MGR) === 1000, String(m.get(COFFEE_MGR)))
check('A: касиру personal 2% = 200', m.get(CASHIER) === 200, String(m.get(CASHIER)))
check('A: підборщику запчастин 0', !m.has(PARTS_MGR))

// B. Продаж запчастини
m = computeCommissionMap([{ product_id:'pParts', sell_price:20000, buy_price:12000, qty:1 }], productsMap, rules, CASHIER)
check('B: підборщику 5% від 20000 = 1000', m.get(PARTS_MGR) === 1000, String(m.get(PARTS_MGR)))
check('B: менеджеру кави 0', !m.has(COFFEE_MGR))

// C. Категорія без власника — лише касир (personal)
m = computeCommissionMap([{ product_id:'pOther', sell_price:5000, buy_price:3000, qty:1 }], productsMap, rules, CASHIER)
check('C: тільки касир 2% = 100', m.get(CASHIER) === 100 && m.size === 1, JSON.stringify([...m]))

// D. Скасована позиція не рахується
m = computeCommissionMap([{ product_id:'pCoffee', item_status:'canceled', sell_price:10000, buy_price:5000, qty:1 }], productsMap, rules, CASHIER)
check('D: скасована позиція → нуль', m.size === 0, JSON.stringify([...m]))

// E. Кількість 3 множиться
m = computeCommissionMap([{ product_id:'pCoffee', sell_price:10000, buy_price:5000, qty:3 }], productsMap, rules, CASHIER)
check('E: кава ×3 → менеджеру 3000', m.get(COFFEE_MGR) === 3000, String(m.get(COFFEE_MGR)))

// F. Сторно повернення = та сама сума (яку викликаючий бере зі знаком мінус)
m = computeCommissionMap([{ product_id:'pCoffee', sell_price:10000, buy_price:5000, qty:1 }], productsMap, rules, CASHIER)
check('F: сторно поверне рівно 1000 менеджеру кави (буде -1000)', m.get(COFFEE_MGR) === 1000)

// G. Власник категорії отримує НАВІТЬ коли продав інший — кава продана підборщиком
m = computeCommissionMap([{ product_id:'pCoffee', sell_price:10000, buy_price:5000, qty:1 }], productsMap, rules, PARTS_MGR)
check('G: кава продана підборщиком → менеджер кави все одно 1000', m.get(COFFEE_MGR) === 1000, String(m.get(COFFEE_MGR)))

console.log(failed===0 ? '\nCOMMISSION LOGIC PASSED' : `\n${failed} FAILED`)
process.exit(failed===0?0:1)
