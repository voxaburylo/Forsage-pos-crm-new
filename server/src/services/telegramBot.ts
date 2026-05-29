import { Telegraf, Markup } from 'telegraf'
import { logger } from '../lib/logger.js'
import { db } from '../db/supabase.js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { getOrCreateChat } from './messengers/MessengerService.js'
import { TaskQueue } from './taskQueue.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID ? Number(process.env.MANAGER_CHAT_ID) : null
if (!BOT_TOKEN) logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled')

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null

// ================================================================
// Inbox helpers — зберігають повідомлення в messenger_chats/messages
// щоб ChatsInbox у фронтенді бачив переписку
// ================================================================

let _mainChannelId: string | null = null

async function getMainChannelId(): Promise<string | null> {
  if (_mainChannelId) return _mainChannelId
  try {
    const { data } = await db
      .from('messenger_channels')
      .select('id')
      .eq('platform', 'telegram')
      .eq('is_active', true)
      .eq('tenant_id', TENANT_ID)
      .limit(1)
      .maybeSingle()
    if (data?.id) {
      _mainChannelId = data.id
      return _mainChannelId
    }
    // Якщо канал не знайдено — auto-create з env-токена
    if (BOT_TOKEN) {
      const { data: created } = await db.from('messenger_channels').insert({
        tenant_id: TENANT_ID,
        name: 'Telegram Bot',
        platform: 'telegram',
        credentials: { token: BOT_TOKEN },
        is_active: true,
      }).select('id').single()
      if (created?.id) {
        _mainChannelId = created.id
        logger.info({ channelId: _mainChannelId }, 'telegramBot: auto-created messenger_channel')
      }
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'getMainChannelId failed')
  }
  return _mainChannelId
}

async function saveToInbox(
  platformChatId: string,
  username: string | undefined,
  firstName: string | undefined,
  text: string,
  customerId?: string | null,
): Promise<void> {
  try {
    const channelId = await getMainChannelId()
    if (!channelId) return

    const { chatId } = await getOrCreateChat(channelId, platformChatId, username, firstName)

    // Якщо знаємо клієнта — прив'язуємо
    if (customerId) {
      await db.from('messenger_chats')
        .update({ customer_id: customerId })
        .eq('id', chatId)
        .is('customer_id', null)
    }

    await db.from('messenger_messages').insert({ chat_id: chatId, sender_type: 'customer', text })

    const { data: cur } = await db.from('messenger_chats').select('unread_count').eq('id', chatId).single()
    await db.from('messenger_chats').update({
      last_message_at: new Date().toISOString(),
      unread_count: (cur?.unread_count ?? 0) + 1,
    }).eq('id', chatId)
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'saveToInbox')
  }
}

// ================================================================
// State (in-memory, resets on restart)
// ================================================================

const lastGreeting  = new Map<string, number>()
const bizConnections = new Map<string, string>()  // chatId string → business_connection_id
const voicePending  = new Map<string, { fileId: string; username?: string }>()
const voiceTranscript = new Map<string, { text: string; username?: string }>()
const userContext   = new Map<string, { carId: string; carLabel: string }>()

const GREETING_COOLDOWN_MS = 24 * 3600_000

let ownerBotId: number | null = null
let ownerUserId: number | null = null

type SendFn = (text: string, extra?: any) => Promise<any>

// ================================================================
// Pure Helpers
// ================================================================

/** Знайти справжній VIN з тексту (розумний пошук з пріоритетом WMI та маркерів) */
export function extractVin(t: string): string | undefined {
  const upper = t.toUpperCase()

  // Слова-сміття — якщо рядок містить їх, це не VIN
  const GARBAGE = /\b(APP|IBAN|ID|API|URL|HTTP|WWW|TEL|FAX|EMAIL|MAIL|PHONE|BANK|ACCOUNT|PASS|SIGN|DATE|NAME|MODEL|COLOR|TYPE|CODE)\b/

  // Маркери, біля яких часто стоїть VIN
  const VIN_MARKERS = /\b(E|VIN|НОМЕР КУЗОВА|IDENTIFICATION|NUMBER|CHASSIS|BODY|КУЗОВ|ШВІ|ШАСІ|VIN\d)\b/

  // Отримуємо всі рядки окремо для точного позиціонування
  const lines = upper.split('\n')

  interface Candidate { vin: string; score: number; needsReplace: boolean }
  const candidates: Candidate[] = []

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Очищаємо рядок: тільки A-Z0-9
    const clean = line.replace(/[^A-Z0-9]/g, '')
    // Шукаємо ВСІ 17-символьні послідовності у cleaned-рядку
    let pos = 0
    while (pos <= clean.length - 17) {
      const chunk = clean.slice(pos, pos + 17)
      pos++

      // Базові перевірки
      // 1. Відкидаємо якщо є I, O, Q — це невалідні символи для VIN
      const hasIllegal = /[IOQ]/.test(chunk)
      // 2. Перевіряємо що це тільки A-Z0-9 (вже гарантовано clean)
      // 3. Перевіряємо що це не сміття
      if (GARBAGE.test(chunk)) continue

      // Базовий скоринг
      let score = 0
      let needsReplace = false
      let candidate = chunk

      // Перевіряємо чи можна виправити через заміну I/O/Q
      if (hasIllegal) {
        const fixed = chunk.replace(/O/g, '0').replace(/I/g, '1').replace(/Q/g, '0')
        // Після заміни перевіряємо, чи став валідним
        if (/[A-HJ-NPR-Z0-9]{17}/.test(fixed)) {
          candidate = fixed
          needsReplace = true
          score -= 2 // Штраф за те що довелось виправляти
        } else {
          continue // Не вдалось виправити — пропускаємо
        }
      }

      // ---- Пріоритетні перевірки ----

      // +10 якщо починається з відомого WMI (4 букви або 3)
      if (WMI[candidate.slice(0, 4)]) score += 10
      else if (WMI[candidate.slice(0, 3)]) score += 8

      // +5 якщо поряд (в межах ±3 рядків) є маркер VIN
      for (let di = -3; di <= 3; di++) {
        const refLine = lines[li + di]
        if (refLine && VIN_MARKERS.test(refLine)) {
          score += 5
          break
        }
      }

      // +3 якщо рядок сам містить маркер (описовий рядок)
      if (VIN_MARKERS.test(line)) score += 3

      // -5 якщо містить надто багато цифр поспіль (VIN має і літери)
      const digitCount = (candidate.match(/\d/g) || []).length
      if (digitCount > 12) score -= 5    // VIN не може бути з 13+ цифр
      if (digitCount < 3) score -= 3      // VIN має хоча б кілька цифр

      // +2 за кожен відомий WMI-символ на позиції 1-3
      if (candidate[0] >= 'A' && candidate[0] <= 'Z') score += 1
      if (candidate[1] >= 'A' && candidate[1] <= 'Z') score += 1

      candidates.push({ vin: candidate, score, needsReplace })
    }
  }

  // Логуємо всі знайдені варіанти
  if (candidates.length > 0) {
    logger.info({ allFoundStrings: candidates.map(c => `${c.vin} (score:${c.score})`) })
  }

  // Сортуємо за score (найвищий перший) і повертаємо найкращий
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.vin
}

function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.startsWith('380')) return `+${d}`
  if (d.startsWith('80'))  return `+3${d}`
  if (d.startsWith('0'))   return `+38${d}`
  return raw
}

function extractPhone(raw: string): string | null {
  const m = raw.replace(/\s/g, '').match(/(?:\+?3?8?)?(0\d{9})/)
  return m ? normalizePhone(m[1]) : null
}

const WMI: Record<string, string> = {
  WBA: 'BMW', WBS: 'BMW', WDB: 'Mercedes-Benz', WDD: 'Mercedes-Benz',
  WAU: 'Audi', WUA: 'Audi', WVW: 'Volkswagen', VF1: 'Renault',
  JTD: 'Toyota', JHM: 'Honda', KMH: 'Hyundai', KNA: 'Kia',
  SAL: 'Land Rover', YV1: 'Volvo', ZAR: 'Alfa Romeo', ZFA: 'Fiat',
  WF0: 'Ford', W0L: 'Opel', JSA: 'Mazda', TMB: 'Škoda',
  VSS: 'Seat', XTA: 'ВАЗ/Lada', XWB: 'ЗАЗ', Z94: 'Hyundai',
}

export function getMake(vin: string): string {
  return WMI[vin.slice(0, 4).toUpperCase()] ?? WMI[vin.slice(0, 3).toUpperCase()] ?? 'Невідомо'
}

// ================================================================
// DB Helpers
// ================================================================

async function getCustomerId(chatId: number | string): Promise<string | null> {
  try {
    const { data: c } = await db.from('customers').select('id').eq('telegram_chat_id', String(chatId)).maybeSingle()
    return c?.id ?? null
  } catch { return null }
}

async function findCustomer(phone: string): Promise<{ id: string } | null> {
  try {
    const { data: e } = await db.from('customers').select('id').eq('phone', phone).maybeSingle()
    if (e) return e
    const { data: a } = await db.from('customers').select('id').eq('phone', phone.replace('+', '')).maybeSingle()
    return a ?? null
  } catch { return null }
}

async function getManagerId(): Promise<string> {
  try {
    const { supabaseAdmin } = await import('../db/supabaseAdmin.js')
    const { data: u } = await supabaseAdmin.auth.admin.listUsers()
    const m = u?.users?.find((x: any) => x.user_metadata?.role === 'admin')
           ?? u?.users?.find((x: any) => x.user_metadata?.role === 'manager')
           ?? u?.users?.[0]
    return m?.id ?? '00000000-0000-0000-0000-000000000000'
  } catch { return '00000000-0000-0000-0000-000000000000' }
}

async function logMsg(chatId: number, text: string, dir: 'incoming' | 'outgoing') {
  try {
    await db.from('telegram_messages').insert({
      tenant_id: TENANT_ID, chat_id: chatId, direction: dir, text: text.slice(0, 3000),
    })
  } catch { /* best-effort */ }
}

async function createLead(chatId: number | string, txt: string, username?: string, carId?: string) {
  const key = String(chatId)

  // Отримуємо UUID чату в Inbox — щоб прив'язати лід до конкретного чату
  let dbChatId: string | null = null
  try {
    const channelId = await getMainChannelId()
    if (channelId) {
      const { chatId: uuid } = await getOrCreateChat(channelId, String(chatId), username)
      dbChatId = uuid
    }
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.message : e }, 'createLead: getOrCreateChat failed')
  }

  // Формуємо vehicle_info: carId → customer_cars або VIN з тексту
  let vehicleInfo: Record<string, any> | null = null
  if (carId) {
    try {
      const { data: car } = await db.from('customer_cars')
        .select('make, model, year, vin').eq('id', carId).maybeSingle()
      if (car) {
        vehicleInfo = { make: car.make, model: car.model, year: car.year, vin: car.vin }
      }
    } catch (e) {
      logger.error({ error: e instanceof Error ? e.message : e }, 'createLead: load car failed')
    }
  } else {
    const extractedVin = extractVin(txt.toUpperCase())
    if (extractedVin) {
      vehicleInfo = { vin: extractedVin, make: getMake(extractedVin) }
    }
  }

  const customerId = await getCustomerId(chatId)

  // Шукаємо існуючий лід (status=lead) за останні 30 хв
  try {
    let query = db
      .from('customer_orders')
      .select('id, comment, vehicle_info')
      .eq('status', 'lead')
      .eq('tenant_id', TENANT_ID)
      .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
      .order('created_at', { ascending: false })

    if (customerId) {
      query = query.or(`customer_id.eq.${customerId},chat_id.eq.${dbChatId}`)
    } else if (dbChatId) {
      query = query.eq('chat_id', dbChatId)
    } else {
      query = null as any
    }

    if (query) {
      const { data: existing } = await query.limit(1).maybeSingle()

      if (existing) {
        const updateData: Record<string, any> = {
          comment: (existing.comment ?? '') + `\n---\n${txt.slice(0, 1500)}`
        }
        
        // Прикріплюємо VIN / автомобіль, якщо раніше не було прикріплено
        if (!existing.vehicle_info && vehicleInfo) {
          updateData.vehicle_info = vehicleInfo
        }

        // Оновлюємо також customer_id, якщо з'явився авторизований клієнт
        if (customerId) {
          updateData.customer_id = customerId
        }

        await db.from('customer_orders').update(updateData).eq('id', existing.id)
        return existing
      }
    }
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.message : e }, 'createLead: check/update existing failed')
  }

  // Створюємо новий лід
  try {
    const managerId  = await getManagerId()
    
    // Додаємо інформацію про авто на початок коментаря для кращої читаємості менеджером в CRM
    let commentText = `📨 Від ${username ?? '#' + key}:\n${txt.slice(0, 1500)}`
    if (vehicleInfo) {
      const carStr = [vehicleInfo.make, vehicleInfo.model, vehicleInfo.year].filter(Boolean).join(' ')
      commentText = `🚗 Авто: ${carStr}${vehicleInfo.vin ? ` (VIN: ${vehicleInfo.vin})` : ''}\n${commentText}`
    }

    const { data, error } = await db.from('customer_orders').insert({
      tenant_id: TENANT_ID, customer_id: customerId ?? null,
      chat_id: dbChatId,
      manager_id: managerId, status: 'lead', total_amount: 0, source: 'telegram_bot',
      vehicle_info: vehicleInfo,
      comment: commentText,
    }).select('id').single()
    if (error) { logger.error({ error: error.message }, 'lead insert'); return null }

    notifyMgr(`📨 *Новий лід з Telegram!*\nКлієнт: ${username ?? '#' + key}\nТекст: ${txt.slice(0, 300)}\nНомер: #${(data?.id ?? '').slice(0, 8)}`).catch(() => {})
    return data
  } catch (err) { 
    logger.error({ error: err instanceof Error ? err.message : err }, 'createLead insert catch')
    return null 
  }
}

async function checkIfRecentLeadExists(chatId: number | string): Promise<boolean> {
  try {
    const customerId = await getCustomerId(chatId)
    const channelId = await getMainChannelId()
    let dbChatId: string | null = null
    if (channelId) {
      const { chatId: uuid } = await getOrCreateChat(channelId, String(chatId))
      dbChatId = uuid
    }

    let query = db
      .from('customer_orders')
      .select('id')
      .eq('status', 'lead')
      .eq('tenant_id', TENANT_ID)
      .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())

    if (customerId) {
      query = query.or(`customer_id.eq.${customerId},chat_id.eq.${dbChatId}`)
    } else if (dbChatId) {
      query = query.eq('chat_id', dbChatId)
    } else {
      return false
    }

    const { data } = await query.limit(1).maybeSingle()
    return !!data
  } catch {
    return false
  }
}

async function notifyMgr(msg: string) {
  if (!bot || !MANAGER_CHAT_ID) return
  try { await bot.telegram.sendMessage(MANAGER_CHAT_ID, msg, { parse_mode: 'Markdown' }) } catch { /* ok */ }
}

export async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  if (!bot) return false
  try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' }); return true }
  catch { return false }
}

/** Отримати список авто клієнта для інлайн-клавіатури */
async function getCustomerCarsList(chatId: number | string): Promise<any[]> {
  try {
    const cid = await getCustomerId(chatId)
    if (!cid) return []
    const { data } = await db.from('customer_cars')
      .select('id, make, model, year, vin').eq('customer_id', cid)
      .order('created_at', { ascending: false }).limit(6)
    return data ?? []
  } catch { return [] }
}

/** Показати клієнту вибір авто. Повертає true, якщо авто знайдені і клавіатура показана */
async function showCarPicker(cars: any[], send: SendFn): Promise<boolean> {
  if (cars.length === 0) return false
  const rows = cars.map(c => [
    { text: `🚘 ${c.make} ${c.model}${c.year ? ` (${c.year})` : ''}`, callback_data: `pick_car_${c.id}` },
  ])
  rows.push([{ text: '➕ Інше авто / Новий VIN', callback_data: 'pick_car_new' }])
  await send('🚗 *Оберіть авто з вашого гаража:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  })
  return true
}

/** Зберегти VIN у customer_cars. Повертає carId або null. Якщо VIN вже є — повертає існуючий. */
async function saveVin(chatId: number | string, vin: string): Promise<string | null> {
  try {
    const cid = await getCustomerId(chatId)
    if (!cid) return null

    // Перевіряємо чи вже є такий VIN у клієнта
    const { data: existing } = await db.from('customer_cars')
      .select('id').eq('customer_id', cid).eq('vin', vin).maybeSingle()
    if (existing) return existing.id

    const { data: ins } = await db.from('customer_cars').insert({
      tenant_id: TENANT_ID, customer_id: cid,
      make: getMake(vin), model: 'VIN: ' + vin.slice(0, 8), vin,
      notes: '📸 Через Telegram-бота',
    }).select('id').single()
    return ins?.id ?? null
  } catch { return null }
}

// ─── Phase 8: Status Notifications ───

export async function notifyStatusUpdate(orderId: string, newStatus: string) {
  if (!bot) return
  try {
    // Отримуємо дані замовлення та клієнта
    const { data: o } = await db.from('customer_orders')
      .select('id, pickup_cell, customer:customers(telegram_chat_id, full_name)')
      .eq('id', orderId)
      .single()

    if (!o) return
    const chatId = (o.customer as any)?.telegram_chat_id
    if (!chatId) return

    const ic: Record<string, string> = {
      lead: '📨', new: '📝', in_progress: '💬', ordered: '🟡',
      arrived: '🟢', called: '📞', no_answer: '⏳', ready: '🟣',
      completed: '✔️', canceled: '❌',
    }
    const lb: Record<string, string> = {
      lead: 'Новий лід', new: 'Нове замовлення', in_progress: 'В роботі', ordered: 'Замовлено',
      arrived: 'Прибуло на склад', called: 'Клієнт повідомлений', no_answer: 'Не відповідає',
      ready: 'Готово до видачі', completed: 'Виконано (Закрито)', canceled: 'Скасовано',
    }
    const pickupCellLine = newStatus === 'ready' && (o as any).pickup_cell
      ? `\n🗄 Комірка видачі: *${(o as any).pickup_cell}*`
      : ''
    const msg = `🔔 *Оновлення статусу замовлення!*\n\n` +
                `📦 Номер: \`#${o.id.slice(0, 8)}\`\n` +
                `📊 Новий статус: ${ic[newStatus] ?? '•'} *${lb[newStatus] ?? newStatus}*` +
                pickupCellLine +
                `\n\nМенеджер Форсаж Авто завжди на зв'язку! 🚀`

    await bot.telegram.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🛍 Мої замовлення', callback_data: 'orders' }]]
      }
    })
    logger.info({ orderId, chatId, newStatus }, 'Status notification sent')
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'notifyStatusUpdate failed')
  }
}

// ================================================================
// Gemini AI OCR
// ================================================================

let genAI: GoogleGenerativeAI | null = null
let geminiModel: any = null

function initGemini() {
  if (!genAI && GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    logger.info('Gemini AI initialized')
  }
  return geminiModel
}

async function ocrPhoto(fileId: string): Promise<string | null> {
  if (!bot || !GEMINI_API_KEY) {
    logger.warn('GEMINI_API_KEY not set')
    return null
  }
  try {
    const model = initGemini()
    if (!model) {
      logger.warn('Gemini model is null – initGemini failed')
      return null
    }

    const link = await bot.telegram.getFileLink(fileId)
    logger.info({ url: link.href }, 'Downloading image')

    // Визначаємо mimeType з URL (Telegram повертає .jpg або .png)
    const ext = link.href.split('.').pop()?.toLowerCase() || 'jpg'
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'

    // Завантажуємо фото
    const axios = (await import('axios')).default
    const resp = await axios.get(link.href, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(resp.data)
    const base64 = buffer.toString('base64')

    // Запит до Gemini — українською для кращого розуміння документів
    const prompt = 'Ти — експерт з автомобілів. На фото документ на авто. Знайди 17-символьний VIN-код. Поверни ТІЛЬКИ сам VIN (17 символів, великі літери). Якщо VIN немає — поверни "NONE".'

    const result = await model.generateContent([
      { inlineData: { mimeType, data: base64 } },
      { text: prompt },
    ])

    const raw = result.response.text().trim()
    logger.info({ geminiRawResponse: raw }, 'Gemini raw result')

    // Спроба 1: прямий пошук 17 символів (строгий, без I/O/Q)
    const clean = raw.replace(/[^A-Z0-9]/gi, '').toUpperCase()
    const strict = clean.match(/[A-HJ-NPR-Z0-9]{17}/)
    if (strict) return strict[0]

    // Спроба 2: з заміною O→0, I→1, Q→0
    const fuzzy = clean.replace(/O/g, '0').replace(/I/g, '1').replace(/Q/g, '0')
    const fuzzyMatch = fuzzy.match(/[A-HJ-NPR-Z0-9]{17}/)
    if (fuzzyMatch) return fuzzyMatch[0]

    // Спроба 3: Gemini повернула VIN але з додатковим текстом
    // Шукаємо будь-яку 17-символьну послідовність
    for (let i = 0; i <= clean.length - 17; i++) {
      const chunk = clean.slice(i, i + 17)
      // Хоча б перші 3 символи мають бути літерами (WMI код виробника)
      if (/^[A-Z0-9]{17}$/.test(chunk) && /[A-Z]/.test(chunk[0]) && /[A-Z]/.test(chunk[1])) {
        return chunk
      }
    }

    if (raw.includes('NONE') || raw.includes('none')) return 'NONE'
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'Gemini API failed')
    if (msg.includes('API_KEY') || msg.includes('key') || msg.includes('not found') || msg.includes('not enabled')) {
      throw err
    }
  }
  return null
}

async function handlePhoto(send: SendFn, fileId: string, chatId: number, username?: string) {
  try {
    await send('📸 Фото отримано, розпізнаю VIN...')
    await TaskQueue.enqueue('ocr_photo', {
      fileId,
      chatId,
      username
    }, {
      tenantId: TENANT_ID
    })
    logger.info({ chatId, fileId }, 'Enqueued ocr_photo background job')
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'handlePhoto error queueing job')
    await send('❌ Не вдалося розпочати розпізнавання. Спробуйте пізніше.')
  }
}

export async function processOcrPhoto(fileId: string, chatId: number, username?: string) {
  if (!bot) return
  const send: SendFn = async (text, extra?) => {
    return bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra })
  }

  try {
    const responseText = await ocrPhoto(fileId)
    if (!responseText) {
      logger.warn({ chatId, fileId }, 'processOcrPhoto: Gemini returned null')
      await send('🔍 На жаль, не вдалося чітко розпізнати VIN. Перевірте логи сервера (geminiRawResponse).')
      return
    }

    if (responseText === 'NONE' || responseText.length !== 17) {
      logger.warn({ geminiResponse: responseText, length: responseText.length }, 'processOcrPhoto: Gemini did not find valid VIN')
      await send(`🔍 Gemini не знайшов VIN. Відповідь AI: \`${responseText.slice(0, 50)}\`. Спробуйте інше фото.`)
      return
    }

    const vin = responseText
    const make = getMake(vin)

    // Зберігаємо VIN в історію чату, щоб менеджер бачив
    const cid = await getCustomerId(chatId)
    saveToInbox(String(chatId), username, undefined, `📸 Фото. Розпізнаний VIN: ${vin} (${make})`, cid).catch(() => {})

    const carId = await saveVin(chatId, vin)
    if (carId) {
      // Авторизований клієнт — питаємо запчастини
      userContext.set(String(chatId), { carId, carLabel: `${make} (${vin})` })
      await send(`✅ VIN \`${vin}\` (${make}) розпізнано!

Які саме запчастини ви шукаєте для цього авто? Напишіть текстом або надішліть голосове повідомлення.`, { parse_mode: 'Markdown', reply_markup: VIN_KB.reply_markup })
    } else {
      // Неавторизований — одразу лід
      await createLead(chatId, `VIN: ${vin} (${make})`, username)
      await send(`✅ VIN \`${vin}\` (${make}) розпізнано!

Менеджер почав підбір.💡 Авторизуйтесь, щоб додати авто до свого гаража.`, { parse_mode: 'Markdown', reply_markup: VIN_KB.reply_markup })
    }
    logger.info({ vin, make }, 'VIN from photo (Gemini) - background job completed')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'processOcrPhoto error')
    if (msg.includes('API_KEY') || msg.includes('key') || msg.includes('not found') || msg.includes('not enabled')) {
      await send('⚠️ *Помилка Gemini AI*: не ввімкнено API або неправильний ключ. Зверніться до адміністратора.', { parse_mode: 'Markdown' })
    } else {
      await send('🔍 На жаль, не вдалося чітко розпізнати VIN. Спробуйте інше фото або введіть VIN текстом.', { parse_mode: 'Markdown' })
    }
    throw err
  }
}

// ================================================================
// Voice → text (Gemini)
// ================================================================

async function handleVoice(send: SendFn, fileId: string, chatId: number, username?: string) {
  if (!bot || !GEMINI_API_KEY) { await send('🎤 Голосові повідомлення тимчасово недоступні.'); return }
  try {
    // Зберігаємо fileId — обробка буде по кнопці
    voicePending.set(String(chatId), { fileId, username })

    await send('🎤 Голосове повідомлення отримано! Натисніть кнопку нижче, щоб розпізнати текст.', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎤 Розпізнати текст', callback_data: 'transcribe_voice' }
        ]]
      }
    })
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'handleVoice')
    await send('❌ Помилка. Спробуйте написати текстом.')
  }
}

/** Завантажити аудіо, розпізнати через Gemini 2.5 Flash, зберегти лід */
async function transcribeVoice(chatId: number, send: SendFn) {
  if (!bot || !GEMINI_API_KEY) { await send('🎤 Голосові повідомлення тимчасово недоступні.'); return }
  const pending = voicePending.get(String(chatId))
  if (!pending) { await send('🎤 Голосове повідомлення вже не доступне. Надішліть нове.'); return }
  voicePending.delete(String(chatId))

  try {
    await send('🎤 Розшифровую голосове повідомлення...')

    const link = await bot.telegram.getFileLink(pending.fileId)
    const resp = await fetch(link.href)
    if (!resp.ok) { await send('❌ Не вдалося завантажити аудіо.'); return }
    const buf = Buffer.from(await resp.arrayBuffer())
    const b64 = buf.toString('base64')

    // Використовуємо спільний initGemini() — gemini-2.5-flash (добре працює з аудіо)
    const model = initGemini()
    if (!model) { await send('❌ Помилка AI.'); return }

    const prompt = `Ти — професійний асистент автомагазину "Форсаж". Твоє завдання: розшифрувати голосове повідомлення клієнта.
1. Виправ технічні помилки (назви запчастин, марок авто: наприклад, "бренбо" -> "Brembo").
2. Повністю видали слова-паразити (еее, ну, якби, коротше).
3. Якщо клієнт називає авто або VIN — виділи їх окремо.
4. Поверни результат у чіткому форматі:
   📌 СУТЬ ЗАПИТУ: [відредагований та зрозумілий текст]
   🚗 АВТО: [марка/модель/рік, якщо було озвучено]

Мова відповіді: українська.`

    const result = await model.generateContent([
      { inlineData: { mimeType: 'audio/ogg', data: b64 } },
      { text: prompt },
    ])
    const transcript = result.response.text().trim()
    logger.info({ transcript }, 'Voice transcript')

    if (!transcript || transcript.length < 2) {
      await send('🎤 Не вдалося розібрати повідомлення. Спробуйте написати текстом.')
      return
    }

    // Показуємо транскрипт клієнту
    await send(`📝 *Розшифровано:* ${transcript}`, { parse_mode: 'Markdown' })

    // Зберігаємо транскрипт в історію чату
    const voiceCid = await getCustomerId(chatId)
    saveToInbox(String(chatId), pending.username, undefined, `🎤 Голосове: ${transcript.slice(0, 500)}`, voiceCid).catch(() => {})

    // Перевіряємо чи є авто в гаражі
    const cars = await getCustomerCarsList(chatId)
    if (cars.length > 0) {
      // Зберігаємо транскрипт — буде використаний після вибору авто
      voiceTranscript.set(String(chatId), { text: transcript, username: pending.username })
      await showCarPicker(cars, send)
    } else {
      // Немає авто — створюємо лід одразу
      await createLead(chatId, `🎤 Голосове: ${transcript}`, pending.username)
      await send('✅ Ваше повідомлення передано менеджеру.', { parse_mode: 'Markdown', reply_markup: MAIN_MENU.reply_markup })
      logger.info({ chatId, transcript }, 'Lead from voice')
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'transcribeVoice')
    await send('❌ Помилка розшифровки. Спробуйте написати текстом.')
  }
}

// ================================================================
// Gemini smart reply for text
// ================================================================

async function geminiReply(text: string): Promise<string | null> {
  if (!GEMINI_API_KEY) return null
  try {
    const model = initGemini()
    if (!model) return null
    const prompt = `Ти — асистент автомагазину Форсаж. Клієнт пише: "${text}". Якщо це питання про запчастини, ціни, сумісність — дай коротку корисну відповідь (1-2 речення). Якщо клієнт просто вітається або пише не по темі — поверни слово "NONE". Відповідай українською.`
    const result = await model.generateContent([{ text: prompt }])
    const reply = result.response.text().trim()
    if (reply === 'NONE' || reply.length < 5) return null
    logger.info({ geminiReply: reply }, 'Gemini smart reply')
    return reply.length > 500 ? reply.slice(0, 500) + '…' : reply
  } catch { return null }
}

// ================================================================
// Auth
// ================================================================

async function authCustomer(chatId: number, phone: string, name: string, send: SendFn) {
  try {
    const existing = await findCustomer(phone)
    let customerId: string | null = null

    if (existing) {
      await db.from('customers').update({ telegram_chat_id: chatId }).eq('id', existing.id)
      customerId = existing.id
    } else {
      const { data: newCust } = await db.from('customers').insert({
        tenant_id: TENANT_ID, phone, full_name: name || 'Клієнт', telegram_chat_id: chatId,
      }).select('id').single()
      customerId = newCust?.id ?? null
    }

    // Прив'язуємо клієнта до чату в Inbox
    if (customerId) {
      const channelId = await getMainChannelId()
      if (channelId) {
        const { chatId: dbChatId } = await getOrCreateChat(channelId, String(chatId))

        await db.from('messenger_chats')
          .update({ customer_id: customerId })
          .eq('channel_id', channelId)
          .eq('platform_chat_id', String(chatId))

        // Знаходимо і оновлюємо нещодавні ліди цього чату, які не мають customer_id
        const { data: recentLeads } = await db
          .from('customer_orders')
          .select('id, vehicle_info')
          .eq('chat_id', dbChatId)
          .is('customer_id', null)
        
        if (recentLeads && recentLeads.length > 0) {
          for (const lead of recentLeads) {
            await db.from('customer_orders')
              .update({ customer_id: customerId })
              .eq('id', lead.id)
            
            // Якщо у ліда був VIN, додаємо його в гараж клієнта
            const vin = lead.vehicle_info?.vin
            if (vin) {
              await saveVin(chatId, vin)
            }
          }
        }
      }
    }

    logger.info({ chatId, phone }, 'Auth ok')
    await send(`✅ Номер *${phone}* збережено.`, { parse_mode: 'Markdown', reply_markup: MAIN_MENU.reply_markup })
    await showMainMenu(chatId, send)
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'authCustomer')
    await send('❌ Помилка збереження. Спробуйте пізніше.').catch(() => {})
  }
}

// ================================================================
// Keyboards
// ================================================================

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('💳 Мій кабінет', 'cabinet')],
  [Markup.button.callback('🛍 Мої замовлення', 'orders')],
  [Markup.button.callback('🚗 Мої автомобілі', 'cars')],
  [Markup.button.callback('📞 Зв\'язатись', 'contact_manager')],
])

const BACK_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('« На головну', 'menu')],
])

const VIN_KB = Markup.inlineKeyboard([
  [Markup.button.callback('💳 Мій кабінет', 'cabinet'), Markup.button.callback('🛍 Мої замовлення', 'orders')],
  [Markup.button.callback('📞 Зв\'язатись з менеджером', 'contact_manager')],
  [Markup.button.callback('« Головне меню', 'menu')],
])

const CONTACT_KB = Markup.keyboard([
  [Markup.button.contactRequest('📱 Надіслати номер телефону')],
]).resize().oneTime()

const CLR_KB = { reply_markup: { remove_keyboard: true } }

// VIP thresholds
const VIP: Record<string, { min: number; icon: string; label: string; next?: string; nextThreshold?: number }> = {
  standard: { min: 0, icon: '⚪', label: 'Стандарт', next: 'bronze', nextThreshold: 3 },
  bronze:   { min: 3, icon: '🥉', label: 'Бронза',   next: 'silver', nextThreshold: 10 },
  silver:   { min: 10, icon: '🥈', label: 'Срібло',   next: 'gold',   nextThreshold: 25 },
  gold:     { min: 25, icon: '🥇', label: 'Золото' },
}

// ================================================================
// Screen Handlers
// ================================================================

async function showMainMenu(_chatId: number, send: SendFn) {
  await send('👋 *Форсаж Авто*\n\nОберіть опцію:', { ...CLR_KB, reply_markup: MAIN_MENU.reply_markup })
}

async function showCabinet(chatId: number, send: SendFn, isBiz = false) {
  let c: any
  try { c = (await db.from('customers').select('*').eq('telegram_chat_id', String(chatId)).maybeSingle()).data }
  catch { c = null }

  if (!c) {
    await send(isBiz
      ? '🔐 *Авторизація*\n\nНапишіть ваш номер телефону (наприклад: `0635823858`)'
      : 'Для доступу до кабінету потрібно авторизуватись:',
      isBiz ? { parse_mode: 'Markdown' } : { ...CONTACT_KB })
    return
  }

  // Count cars & orders
  let carC = 0, ordC = 0
  try {
    const [cr, or] = await Promise.all([
      db.from('customer_cars').select('id', { count: 'exact', head: true }).eq('customer_id', c.id),
      db.from('customer_orders').select('id', { count: 'exact', head: true }).eq('customer_id', c.id),
    ])
    carC = cr.count ?? 0; ordC = or.count ?? 0
  } catch { /* counts unavailable */ }

  const bonus = ((c.bonus_balance ?? 0) / 100).toFixed(2)
  const debt  = ((c.debt_balance ?? 0) / 100).toFixed(2)
  const vi = VIP[c.vip_level ?? 'standard'] ?? VIP.standard

  // Progress bar
  let prog = ''
  if (vi.next && vi.nextThreshold) {
    const nv  = VIP[vi.next]
    const done = Math.min(ordC - vi.min, vi.nextThreshold - vi.min)
    const total = vi.nextThreshold - vi.min
    const fill = Math.round((done / total) * 10)
    const bar  = '🟦'.repeat(fill) + '⬜'.repeat(10 - fill)
    const rem  = Math.max(vi.nextThreshold - ordC, 0)
    prog = `\n${bar}  ${ordC}/${vi.nextThreshold}\n➡ ${rem} замовлень до ${nv.icon} ${nv.label}`
  }

  await send([
    `👤 *${c.full_name ?? 'Клієнт'}*`,
    `📞 \`${c.phone}\``,
    `💳 ${vi.icon} *${vi.label}*`,
    prog,
    '',
    `💰 Бонусів: *${bonus} грн*`,
    c.debt_balance > 0 ? `📋 Борг: *${debt} грн*` : null,
    `🚗 Авто: ${carC}`,
    `📦 Замовлень: ${ordC}`,
  ].filter(Boolean).join('\n'), { parse_mode: 'Markdown', ...CLR_KB, reply_markup: MAIN_MENU.reply_markup })

  // Barcode
  const code = c.card_barcode || '200' + String(Math.floor(Math.random() * 1_000_000_000)).padStart(10, '0')
  if (!c.card_barcode) try { await db.from('customers').update({ card_barcode: code }).eq('id', c.id) } catch { /* ok */ }
  if (bot) {
    await bot.telegram.sendPhoto(chatId, `https://barcode.tec-it.com/barcode.ashx?data=${code}&code=Code128&dpi=96`, {
      caption: `🎫 Картка лояльності: \`${code}\``,
      business_connection_id: bizConnections.get(String(chatId)) ?? null,
    } as any).catch(() => {})
  }
}

async function showOrders(chatId: number, send: SendFn, isBiz = false) {
  const custId = await getCustomerId(chatId)
  if (!custId) {
    await send('Для доступу потрібно авторизуватись:', isBiz ? {} : { ...CONTACT_KB })
    return
  }
  let orders: any[] = []
  try {
    const r = await db.from('customer_orders').select('id, status, total_amount, created_at')
      .eq('customer_id', custId).order('created_at', { ascending: false }).limit(10)
    orders = r.data ?? []
  } catch { orders = [] }
  if (orders.length === 0) {
    await send('📭 *У вас ще немає замовлень.*', { parse_mode: 'Markdown', ...CLR_KB, reply_markup: BACK_MENU.reply_markup })
    return
  }
  const ic: Record<string, string> = { lead: '📨', new: '📝', in_progress: '💬', ordered: '🟡', arrived: '🟢', called: '📞', no_answer: '⏳', ready: '🟣', completed: '✔️', canceled: '❌' }
  const lb: Record<string, string> = { lead: 'Новий лід', new: 'Нове', in_progress: 'В роботі', ordered: 'Замовлено', arrived: 'Прибуло', called: 'Повідомлено', no_answer: 'Не відповідає', ready: 'Готово', completed: 'Виконано', canceled: 'Скасовано' }

  const msg = '📦 *Ваші замовлення:*\n' + orders.map((o, i) =>
    `\n${i + 1}. ${ic[o.status] ?? '•'} *#${o.id.slice(0, 8)}* — ${lb[o.status] ?? o.status}\n   ${((o.total_amount ?? 0) / 100).toFixed(2)} грн (${new Date(o.created_at).toLocaleDateString('uk-UA')})`
  ).join('')

  const buttons = orders.map(o => [Markup.button.callback(`🔍 Деталі #${o.id.slice(0, 8)}`, `order_info_${o.id}`)])
  buttons.push([Markup.button.callback('« На головну', 'menu')])

  await send(msg, { parse_mode: 'Markdown', ...CLR_KB, reply_markup: { inline_keyboard: buttons } })
}

async function showOrderDetails(_chatId: number, orderId: string, send: SendFn) {
  try {
    const { data: o, error } = await db.from('customer_orders')
      .select('*, customer_order_items(*)')
      .eq('id', orderId)
      .single()

    if (error || !o) { await send('❌ Замовлення не знайдено.'); return }

    const ic: Record<string, string> = { lead: '📨', new: '📝', in_progress: '💬', ordered: '🟡', arrived: '🟢', called: '📞', no_answer: '⏳', ready: '🟣', completed: '✔️', canceled: '❌' }
    const lb: Record<string, string> = { lead: 'Новий лід', new: 'Нове', in_progress: 'В роботі', ordered: 'Замовлено', arrived: 'Прибуло', called: 'Повідомлено', no_answer: 'Не відповідає', ready: 'Готово', completed: 'Виконано', canceled: 'Скасовано' }

    let itemsMsg = ''
    if (o.customer_order_items && o.customer_order_items.length > 0) {
      itemsMsg = '\n\n*Позиції:*\n' + o.customer_order_items.map((it: any, i: number) =>
        `${i+1}. ${it.name || 'Запчастина'}\n   💰 ${((it.sell_price ?? 0) / 100).toFixed(2)} грн`
      ).join('\n')
    }

    const msg = `📦 *Замовлення #${o.id.slice(0, 8)}*\n` +
                `📅 Від: ${new Date(o.created_at).toLocaleDateString('uk-UA')}\n` +
                `📊 Статус: ${ic[o.status] ?? '•'} *${lb[o.status] ?? o.status}*\n` +
                `💰 Сума: *${((o.total_amount ?? 0) / 100).toFixed(2)} грн*` +
                (o.prepayment > 0 ? `\n💳 Передоплата: ${(o.prepayment / 100).toFixed(2)} грн` : '') +
                itemsMsg +
                `\n\n🔹 Для замовлення нових запчастин надішліть VIN-код.`

    await send(msg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[Markup.button.callback('« До списку', 'orders')]] }
    })
  } catch (err) {
    logger.error({ error: err }, 'showOrderDetails failed')
    await send('❌ Помилка завантаження деталей.')
  }
}

async function showCars(chatId: number, send: SendFn, isBiz = false) {
  const custId = await getCustomerId(chatId)
  if (!custId) {
    await send('Для доступу потрібно авторизуватись:', isBiz ? {} : { ...CONTACT_KB })
    return
  }
  let cars: any[] = []
  try {
    const r = await db.from('customer_cars').select('id, make, model, vin, year, notes')
      .eq('customer_id', custId).order('created_at', { ascending: false }).limit(10)
    cars = r.data ?? []
  } catch { cars = [] }
  if (cars.length === 0) {
    await send('🚗 *Ваш гараж порожній.*\n\n💡 Надішліть фото техпаспорта або VIN-код, щоб додати авто.', { parse_mode: 'Markdown', ...CLR_KB, reply_markup: BACK_MENU.reply_markup })
    return
  }

  const rows = cars.map(c => [
    { text: `🚘 ${c.make} ${c.model}${c.year ? ` (${c.year})` : ''}`, callback_data: `car_view_${c.id}` },
  ])
  rows.push([{ text: '« На головну', callback_data: 'menu' }])

  await send('🚗 *Ваш гараж:*\n\nОберіть авто щоб переглянути деталі або замовити запчастини.', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  })
}

/** Деталі авто + кнопки дій */
async function showCarDetail(carId: string, _chatId: number, send: SendFn) {
  try {
    const { data: car } = await db.from('customer_cars').select('*').eq('id', carId).single()
    if (!car) { await send('❌ Авто не знайдено.'); return }

    const msg = [
      `🚘 *${car.make} ${car.model}*${car.year ? ` (${car.year})` : ''}`,
      car.vin ? `🔑 VIN: \`${car.vin}\`` : null,
      car.notes ? `📝 Нотатки: ${car.notes}` : null,
      `🆔 ID: \`${car.id.slice(0, 8)}…\``,
    ].filter(Boolean).join('\n')

    await send(msg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 Підібрати запчастини', callback_data: `car_parts_${car.id}` }],
          [{ text: '🗑 Видалити авто', callback_data: `car_delete_${car.id}` }],
          [{ text: '« Назад до гаража', callback_data: 'cars' }],
        ],
      },
    })
  } catch {
    await send('❌ Помилка завантаження авто.')
  }
}

/** Підтвердження та видалення авто з customer_cars */
async function confirmDeleteCar(carId: string, _chatId: number, send: SendFn) {
  try {
    const { data: car } = await db.from('customer_cars').select('make, model').eq('id', carId).single()
    if (!car) { await send('❌ Авто не знайдено.'); return }
    await send(`🗑 *Видалити ${car.make} ${car.model}?*\n\nЦя дія незворотна. Авто буде видалено з вашого гаража.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Так, видалити', callback_data: `car_delete_confirm_${carId}` }],
          [{ text: '« Скасувати', callback_data: `car_view_${carId}` }],
        ],
      },
    })
  } catch {
    await send('❌ Помилка.')
  }
}

async function deleteCar(carId: string, _chatId: number, send: SendFn) {
  try {
    await db.from('customer_cars').delete().eq('id', carId)
    await send('✅ Авто видалено з вашого гаража.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚗 До гаража', callback_data: 'cars' }]] } })
  } catch {
    await send('❌ Не вдалося видалити авто.')
  }
}

// ================================================================
// Bot Init
// ================================================================

export function startBot() {
  if (!bot) return

  bot.telegram.getMe().then((me) => { ownerBotId = me.id }).catch(() => {})

  // Startup Gemini test
  ;(async () => {
    if (!GEMINI_API_KEY) { logger.warn('GEMINI_API_KEY not set – OCR disabled'); return }
    try {
      const model = initGemini()
      if (!model) { logger.warn('Gemini model init failed at startup'); return }
      const r = await model.generateContent('Reply with OK')
      const t = r.response.text().trim()
      logger.info({ geminiTest: t }, 'Gemini startup test')
    } catch (e: any) {
      logger.error({ error: e.message }, 'Gemini startup test FAILED')
      logger.warn('Gemini AI буде недоступний для розпізнавання VIN!')
    }
  })()

  // Detect business account owner
  bot.on('business_connection' as any, (ctx: any) => {
    ownerUserId = ctx.update.business_connection.user.id
    logger.info({ ownerUserId }, 'Owner ID detected')
  })

  // Reply in business chat (always passes business_connection_id)
  async function bizReply(chatId: number, text: string, extra?: any) {
    if (!bot) return
    const connId = bizConnections.get(String(chatId))
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', business_connection_id: connId, ...extra })
      logMsg(chatId, text, 'outgoing')
    } catch (err) {
      logger.error({ chatId, error: err instanceof Error ? err.message : err }, 'bizReply')
    }
  }

  // ─── Unified handler for messages (direct + business) ───
  async function onMsg(ctx: any, isBiz: boolean) {
    try {
      const src = isBiz ? ctx.update.business_message : (ctx.message ?? ctx.update?.message)
      if (!src) return

      const chatId: number = src.chat?.id ?? src.from?.id ?? 0
      const fromId: number = src.from?.id ?? 0
      if (!chatId) return

      // Ignore bot & owner
      if (ownerBotId && fromId === ownerBotId) return
      if (ownerUserId && fromId === ownerUserId) return
      // У business_message: якщо немає sender_user — це пише власник, ігноруємо
      if (isBiz && !src.sender_user) {
        // Зберігаємо ID власника на майбутнє, якщо ще не збережено
        if (!ownerUserId) ownerUserId = fromId
        logger.debug({ fromId }, 'Business owner message ignored (no sender_user)')
        return
      }

      const send: SendFn = isBiz
        ? (t, e?) => bizReply(chatId, t, e)
        : (t, e?) => ctx.reply(t, { parse_mode: 'Markdown', ...e }).catch(() => {})

      const text: string = src.text ?? src.caption ?? ''

      // Log incoming
      if (text) logMsg(chatId, text, 'incoming')

      // Зберігаємо в ChatsInbox (тільки для прямих чатів, не business)
      if (!isBiz && text) {
        const cid = await getCustomerId(chatId)
        
        // Перевіряємо чи є активний контекст автомобіля
        let textToSave = text
        const carCtx = userContext.get(String(chatId))
        if (carCtx && carCtx.carLabel) {
          textToSave = `🚗 [${carCtx.carLabel}]\n${text}`
        }
        
        saveToInbox(String(chatId), src.from?.username, src.from?.first_name, textToSave, cid).catch(() => {})
      }

      // Contact shared
      if (src.contact) {
        const phone = normalizePhone(src.contact.phone_number ?? '')
        if (phone) await authCustomer(chatId, phone, src.from?.first_name ?? '', send)
        return
      }

      // Photo → OCR
      if (src.photo) {
        await handlePhoto(send, src.photo[src.photo.length - 1].file_id, chatId, src.from?.username)
        return
      }

      // Voice → transcript
      if (src.voice) {
        await handleVoice(send, src.voice.file_id, chatId, src.from?.username)
        return
      }

      if (!text) return

      // Business: phone number in text
      if (isBiz) {
        const p = extractPhone(text)
        if (p) { await authCustomer(chatId, p, src.from?.first_name ?? '', send); return }
      }

      // /start, /menu
      if (text === '/start' || /^(меню|menu)$/i.test(text)) {
        const c = await getCustomerId(chatId)
        if (!c) {
          await send(isBiz
            ? '👋 *Форсаж Авто*\n\n🔐 Напишіть номер телефону (наприклад: `0635823858`)'
            : '👋 *Форсаж Авто*\n\nПоділіться номером:',
            isBiz ? { parse_mode: 'Markdown' } : { parse_mode: 'Markdown', ...CONTACT_KB })
          return
        }
        await showMainMenu(chatId, send)
        return
      }

      // VIN
      const vin = extractVin(text.toUpperCase())
      if (vin) {
        const carId = await saveVin(chatId, vin)
        const authed = !!(await getCustomerId(chatId))
        
        // Очищаємо текст від VIN та маркерів, щоб перевірити чи є додатковий опис запиту
        const cleanText = text.replace(new RegExp(vin, 'gi'), '')
                              .replace(/\b(E|VIN|НОМЕР КУЗОВА|IDENTIFICATION|NUMBER|CHASSIS|BODY|КУЗОВ|ШВІ|ШАСІ|VIN\d)\b/gi, '')
                              .trim()
        const hasOtherText = cleanText.length > 5

        if (hasOtherText) {
          // Якщо є опис запиту разом з VIN-кодом — створюємо лід одразу
          await createLead(chatId, text, src.from?.username, carId ?? undefined)
          const make = getMake(vin)
          await send(`✅ *Заявку прийнято!*
🚘 Авто: *${make}* (VIN: \`${vin}\`)
📝 Запит: *${cleanText}*

Менеджер вже опрацьовує ваш запит. 🚀`, { parse_mode: 'Markdown', reply_markup: MAIN_MENU.reply_markup })
          return
        }

        if (authed && carId) {
          // Авторизований клієнт — питаємо запчастини, створюємо лід після відповіді
          const make = getMake(vin)
          userContext.set(String(chatId), { carId, carLabel: `${make} (${vin})` })
          await send(`✅ *VIN знайдено!* \`${vin}\` (${make})

Які саме запчастини ви шукаєте для цього авто? Напишіть текстом або надішліть голосове повідомлення.`,
            { parse_mode: 'Markdown', ...CLR_KB, reply_markup: VIN_KB.reply_markup })
        } else {
          // Неавторизований — одразу створюємо лід (без прив'язки до авто)
          await createLead(chatId, text, src.from?.username)
          await send(authed
            ? `✅ *VIN знайдено!* \`${vin}\` (${getMake(vin)})\n\nМенеджер почав підбір.`
            : `✅ *VIN знайдено!* \`${vin}\` (${getMake(vin)})\n\nМенеджер почав підбір.\n💡 Авторизуйтесь для історії авто.`,
            { parse_mode: 'Markdown', ...CLR_KB, reply_markup: VIN_KB.reply_markup })
        }
        return
      }

      // Business: silent for normal text (greet once per 24h)
      if (isBiz) {
        if (!(await getCustomerId(chatId))) {
          const last = lastGreeting.get(String(chatId)) ?? 0
          if (Date.now() - last > GREETING_COOLDOWN_MS) {
            lastGreeting.set(String(chatId), Date.now())
            await send('👋 *Форсаж Авто*\n\n🔐 Напишіть номер телефону (наприклад: `0635823858`).\n\nАбо надішліть фото VIN.', { parse_mode: 'Markdown' })
          }
        }
        return
      }

      // Перевіряємо чи клієнт у стані введення запчастин (після VIN/вибору авто)
      const carCtx = userContext.get(String(chatId))
      if (carCtx) {
        userContext.delete(String(chatId))
        const label = carCtx.carLabel ? ` для ${carCtx.carLabel}` : ''
        await createLead(chatId, text, src.from?.username, carCtx.carId)
        await send(`📝 *Ваше замовлення${label} передано менеджеру.*

✅ Дякуємо! Менеджер опрацює й найближчим часом зв'яжеться з вами.`,
          { parse_mode: 'Markdown', ...CLR_KB, reply_markup: MAIN_MENU.reply_markup })
        notifyMgr(`📨 *Запит запчастин${label}*\nКлієнт: #${chatId}\nТекст: ${text.slice(0, 300)}`).catch(() => {})
        return
      }

      // Перевіряємо чи є активний лід за останні 30 хвилин для цього чату/клієнта.
      // Якщо є, додаємо це повідомлення туди як додатковий коментар/запит.
      const hasRecentLead = await checkIfRecentLeadExists(chatId)
      if (hasRecentLead) {
        await createLead(chatId, text, src.from?.username)
        await send('📝 *Ваше повідомлення додано до існуючого запиту.* Менеджер незабаром зв\'яжеться з вами!', { parse_mode: 'Markdown', reply_markup: MAIN_MENU.reply_markup })
        return
      }

      // Direct chat: Gemini smart reply, без створення пустого ліда
      const isAuthed = !!(await getCustomerId(chatId))
      if (isAuthed) {
        // Спробуємо відповісти через Gemini
        const aiReply = await geminiReply(text)
        if (aiReply) {
          await send(`🤖 *Форсаж AI:* ${aiReply}`, { parse_mode: 'Markdown', ...CLR_KB, reply_markup: MAIN_MENU.reply_markup })
        } else {
          await showMainMenu(chatId, send)
        }
      } else {
        await send('👋 *Форсаж Авто*\n\nПовідомлення передано менеджеру.\n\n💡 Авторизуйтесь для доступу до кабінету.', { parse_mode: 'Markdown', reply_markup: CONTACT_KB.reply_markup })
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : err }, 'onMsg')
    }
  }

  // ─── Unified handler for callbacks (direct + business) ───
  async function onCb(ctx: any, isBiz: boolean) {
    try {
      const cb = isBiz ? ctx.update.business_callback_query : ctx.callbackQuery
      if (!cb) return
      const chatId: number = cb.message?.chat?.id ?? cb.from?.id ?? 0
      if (!chatId) return
      if (ownerBotId && cb.from?.id === ownerBotId) return
      if (ownerUserId && cb.from?.id === ownerUserId) return

      if (isBiz) {
        const connId = cb.business_connection_id ?? cb.message?.business_connection_id
        if (connId) bizConnections.set(String(chatId), connId)
      }
      await ctx.answerCbQuery().catch(() => {})

      const send: SendFn = isBiz
        ? (t, e?) => bizReply(chatId, t, e)
        : (t, e?) => ctx.reply(t, { parse_mode: 'Markdown', ...e }).catch(() => {})

      const actions: Record<string, () => Promise<void>> = {
        menu:    () => showMainMenu(chatId, send),
        cabinet: () => showCabinet(chatId, send, isBiz),
        orders:  () => showOrders(chatId, send, isBiz),
        cars:    () => showCars(chatId, send, isBiz),
        contact_manager: () => send('📞 *Зв\'язок з менеджером*\n\nНапишіть питання — менеджер зв\'яжеться.', { parse_mode: 'Markdown', ...CLR_KB, reply_markup: BACK_MENU.reply_markup }),
        transcribe_voice: () => transcribeVoice(chatId, send),
        pick_car_new: async () => {
          const pendingTranscript = voiceTranscript.get(String(chatId))
          const cid = await getCustomerId(chatId)
          saveToInbox(String(chatId), cb.from?.username, undefined, `➕ Обрано: інше авто / новий VIN`, cid).catch(() => {})

          if (pendingTranscript) {
            voiceTranscript.delete(String(chatId))
            await createLead(chatId, `🎤 Голосове: ${pendingTranscript.text}`, pendingTranscript.username)
            await send('📝 Замовлення створено без прив\'язки до авто.\n\nЩоб додати нове авто, надішліть VIN-код.', { parse_mode: 'Markdown', ...CLR_KB })
          } else {
            await send('📝 Надішліть VIN-код вашого авто текстом або фото техпаспорта, щоб ми додали його в систему.', { parse_mode: 'Markdown', ...CLR_KB })
          }
        },
      }

      if (cb.data.startsWith('pick_car_')) {
        const carId = cb.data.replace('pick_car_', '')
        try {
          const { data: car } = await db.from('customer_cars').select('make, model, vin').eq('id', carId).single()
          const label = car ? `${car.make} ${car.model}${car.vin ? ` (${car.vin})` : ''}` : ''

          const cid = await getCustomerId(chatId)
          // Зберігаємо вибір авто в повідомлення для менеджера в CRM
          saveToInbox(String(chatId), cb.from?.username, undefined, `🚗 Обрано авто: ${label}`, cid).catch(() => {})

          // Перевіряємо чи є pending транскрипт голосу
          const pendingTranscript = voiceTranscript.get(String(chatId))
          if (pendingTranscript) {
            voiceTranscript.delete(String(chatId))
            await createLead(chatId, `🎤 Голосове: ${pendingTranscript.text}`, pendingTranscript.username, carId)
            await send(`🚘 Авто *${label}* — додано до замовлення.

📝 *Розшифровано:* ${pendingTranscript.text}

✅ Ваше повідомлення передано менеджеру.`, { parse_mode: 'Markdown', reply_markup: MAIN_MENU.reply_markup })
          } else {
            // Звичайний флоу: чекаємо текст запчастин
            userContext.set(String(chatId), { carId, carLabel: label })
            await send(`🚘 Обрано *${label}*

Які саме запчастини вам потрібні? Напишіть текстом або надішліть голосове повідомлення.`,
              { parse_mode: 'Markdown' })
          }
        } catch {
          await send('❌ Не вдалося знайти авто. Спробуйте ще раз.')
        }
        return
      }

      if (cb.data.startsWith('order_info_')) {
        const id = cb.data.replace('order_info_', '')
        await showOrderDetails(chatId, id, send)
        return
      }

      if (cb.data.startsWith('car_view_')) {
        const id = cb.data.replace('car_view_', '')
        await showCarDetail(id, chatId, send)
        return
      }

      if (cb.data.startsWith('car_parts_')) {
        const id = cb.data.replace('car_parts_', '')
        try {
          const { data: car } = await db.from('customer_cars').select('make, model, vin').eq('id', id).single()
          const label = car ? `${car.make} ${car.model}${car.vin ? ` (${car.vin})` : ''}` : ''

          const cid = await getCustomerId(chatId)
          // Зберігаємо вибір авто в повідомлення для менеджера в CRM
          saveToInbox(String(chatId), cb.from?.username, undefined, `🚗 Запит підбору для авто: ${label}`, cid).catch(() => {})

          userContext.set(String(chatId), { carId: id, carLabel: label })
          await send(`🔍 Ви обрали підбір для *${label}*.

Що саме шукаєте? Напишіть назву деталі або надішліть голосове повідомлення.`, { parse_mode: 'Markdown' })
        } catch {
          await send('❌ Помилка.')
        }
        return
      }

      if (cb.data.startsWith('car_delete_confirm_')) {
        const id = cb.data.replace('car_delete_confirm_', '')
        await deleteCar(id, chatId, send)
        return
      }

      if (cb.data.startsWith('car_delete_')) {
        const id = cb.data.replace('car_delete_', '')
        await confirmDeleteCar(id, chatId, send)
        return
      }

      await (actions[cb.data] ?? (() => showMainMenu(chatId, send)))()
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : err }, 'onCb')
    }
  }

  // ─── Register handlers ───
  bot.on('message',                 async (ctx: any) => { await onMsg(ctx, false) })
  bot.on('callback_query',          async (ctx: any) => { await onCb(ctx, false) })
  bot.on('business_message' as any, async (ctx: any) => {
    const m = ctx.update.business_message
    if (m.business_connection_id && m.chat?.id) bizConnections.set(String(m.chat.id), m.business_connection_id)
    await onMsg(ctx, true)
  })
  bot.on('business_callback_query' as any, async (ctx: any) => { await onCb(ctx, true) })

  logger.info('Bot handlers registered')

  bot.launch({
    allowedUpdates: ['message', 'callback_query', 'business_message', 'business_callback_query', 'business_connection', 'photo', 'voice'] as any,
  }).then(() => logger.info('Telegram bot started'))
    .catch((err) => logger.error({ error: err.message }, 'Bot failed'))
}

export function stopBot() {
  if (bot) { bot.stop('SIGTERM'); logger.info('Telegram bot stopped') }
}
