/** Validate types before rendering or writing. Missing editable values are allowed; malformed structures are not. */
export function assertAiOrderShape(payload: unknown): asserts payload is Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ШІ повернув некоректні дані замовлення. Повторіть розпізнавання.')
  const raw=payload as Record<string,unknown>
  const text=(value:unknown,label:string)=>{
    if(value!==undefined&&value!==null&&typeof value!=='string') throw new Error('Некоректне поле «'+label+'». Значення має бути текстом.')
  }
  const number=(value:unknown,label:string)=>{
    if(value!==undefined&&value!==null&&(typeof value!=='string'&&typeof value!=='number'||typeof value==='number'&&!Number.isFinite(value))) throw new Error('Некоректне поле «'+label+'». Перевірте число.')
  }
  for(const key of ['customer_name','customer_phone','car_make','car_model','vin','plate','comment']) text(raw[key],key)
  number(raw.car_year,'рік')
  if(raw.items===undefined||raw.items===null)return
  if(!Array.isArray(raw.items)||raw.items.length>2000)throw new Error('Некоректний список позицій замовлення. Жоден рядок не пропущено.')
  for(const [index,item] of raw.items.entries()){
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Некоректна позиція '+(index+1)+'. Жоден рядок не пропущено.')
    text(item.name,'назва');text(item.part_number,'артикул')
    number(item.qty,'кількість');number(item.sell_price_uah,'ціна продажу');number(item.buy_price_uah,'ціна закупівлі')
    if(item.arrived!==undefined&&item.arrived!==null&&typeof item.arrived!=='boolean')throw new Error('Некоректний стан надходження позиції '+(index+1))
  }
}
