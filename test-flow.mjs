import { chromium } from 'playwright';
import pkg from 'pg';
const { Client } = pkg;
import { join } from 'path';
import { existsSync, copyFileSync } from 'fs';

// Директория для скриншотов (папка артефактов текущей сессии)
const ARTIFACT_DIR = 'C:/Users/neo/.gemini/antigravity/brain/348f50b5-2d05-4ab3-9bb1-36de493be292';
const PHOTO_SOURCE_PATH = join(ARTIFACT_DIR, 'test_product_photo_1779982618645.png');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('🚀 Начинаем сквозное тестирование CRM Форсаж...');

  // Инициализация Playwright
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  // Автоматически подтверждаем все браузерные диалоговые окна (confirm/alert)
  page.on('dialog', async (dialog) => {
    console.log(`💬 Диалоговое окно [${dialog.type()}]: "${dialog.message()}"`);
    await dialog.accept();
  });

  // Выводим все сообщения консоли браузера для отладки
  page.on('console', msg => {
    console.log(`💻 [Браузер] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.error(`💻 [Браузерная ошибка]: ${err.message}`);
  });

  // Логируем все неудачные сетевые запросы
  page.on('requestfailed', request => {
    console.log(`❌ Сетевой запрос провален: ${request.url()} - ${request.failure()?.errorText}`);
  });
  page.on('response', async response => {
    if (response.status() >= 400) {
      console.log(`❌ Network response error ${response.status()}: ${response.url()}`);
      try {
        const text = await response.text();
        console.log(`   Response body: ${text}`);
      } catch (e) {}
    }
  });

  // Соединение с БД
  const dbConnectionString = "postgresql://postgres.zuhanlspejgizjbwbnda:80676462789voxa@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
  const dbClient = new Client({ connectionString: dbConnectionString });
  await dbClient.connect();
  console.log('✅ Успешное подключение к базе данных Supabase!');

  // Предварительная очистка базы для обеспечения идемпотентности
  console.log('🧹 Очистка тестовых данных в БД перед запуском...');
  try {
    // 1. Очистка сообщений мессенджера (зависит от чатов)
    await dbClient.query("DELETE FROM messenger_messages WHERE chat_id IN (SELECT id FROM messenger_chats WHERE customer_id IN (SELECT id FROM customers WHERE phone = '+380991112233'))");
    await dbClient.query("DELETE FROM messenger_messages WHERE chat_id = 'e0000000-0000-0000-0000-000000000001'");

    // 2. Очистка чатов мессенджера (зависит от клиентов)
    await dbClient.query("DELETE FROM messenger_chats WHERE customer_id IN (SELECT id FROM customers WHERE phone = '+380991112233') OR id = 'e0000000-0000-0000-0000-000000000001'");

    // 3. Очистка позиций заказов (зависит от заказов)
    await dbClient.query("DELETE FROM customer_order_items WHERE order_id IN (SELECT id FROM customer_orders WHERE customer_id IN (SELECT id FROM customers WHERE phone = '+380991112233'))");
    await dbClient.query("DELETE FROM customer_order_items WHERE sku IN ('TEST-PADS-100', 'TESTPADS100')");

    // 4. Очистка заказов (зависит от клиентов)
    await dbClient.query("DELETE FROM customer_orders WHERE customer_id IN (SELECT id FROM customers WHERE phone = '+380991112233')");

    // 5. Очистка позиций продаж (зависит от продаж и товаров)
    await dbClient.query("DELETE FROM sale_items WHERE product_id IN (SELECT id FROM products WHERE sku IN ('TEST-PADS-100', 'TESTPADS100'))");

    // 6. Очистка продаж (зависит от клиентов)
    await dbClient.query("DELETE FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE phone = '+380991112233')");

    // 7. Очистка позиций приходных накладных (зависит от товаров)
    await dbClient.query("DELETE FROM supply_invoice_items WHERE product_id IN (SELECT id FROM products WHERE sku IN ('TEST-PADS-100', 'TESTPADS100'))");

    // 8. Очистка приходных накладных (зависит от поставщиков)
    await dbClient.query("DELETE FROM supply_invoices WHERE supplier_id IN (SELECT id FROM suppliers WHERE name = 'Автодистрибьютор Украина')");

    // 9. Очистка выплат зарплат
    await dbClient.query("DELETE FROM salary_payments WHERE note LIKE '%автотест%'");

    // 10. Очистка основных сущностей (товары, клиенты, поставщики)
    await dbClient.query("DELETE FROM products WHERE sku IN ('TEST-PADS-100', 'TESTPADS100')");
    await dbClient.query("DELETE FROM customers WHERE phone = '+380991112233'");
    await dbClient.query("DELETE FROM suppliers WHERE name = 'Автодистрибьютор Украина'");

    console.log('🧹 Очистка завершена!');
  } catch (cleanError) {
    console.warn('⚠️ Ошибка при очистке (возможно, таблицы пусты):', cleanError.message);
  }

  try {
    // -------------------------------------------------------------
    // Шаг 1: Авторизация (Login)
    // -------------------------------------------------------------
    console.log('👉 Шаг 1: Авторизация...');
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('input[type="tel"]');
    await page.fill('input[type="tel"]', '+380635823858');
    await page.fill('input[type="password"]', 'Forsage2026');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_1_dashboard.png') });
    console.log('✅ Шаг 1 завершен!');

    // -------------------------------------------------------------
    // Шаг 2: Каналы связи (Telegram-настройки)
    // -------------------------------------------------------------
    console.log('👉 Шаг 2: Каналы связи...');
    await page.goto('http://localhost:5173/settings/channels');
    await page.waitForSelector('text=Канали зв\'язку');
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_2_channels.png') });
    console.log('✅ Шаг 2 завершен!');

    // -------------------------------------------------------------
    // Шаг 3: Настройки магазина
    // -------------------------------------------------------------
    console.log('👉 Шаг 3: Настройки магазина...');
    await page.goto('http://localhost:5173/settings');
    await page.waitForSelector('input[placeholder="Форсаж Авто"]');
    await page.fill('input[placeholder="Форсаж Авто"]', 'Форсаж Тест-Драйв');
    await page.click('button[type="submit"]');
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_3_settings.png') });
    console.log('✅ Шаг 3 завершен!');

    // -------------------------------------------------------------
    // Шаг 4: Каталог — Создание бренда и категории
    // -------------------------------------------------------------
    console.log('👉 Шаг 4: Проверка каталога товаров...');
    await page.goto('http://localhost:5173/products');
    await page.waitForSelector('text=Товари');
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_4_catalog.png') });
    console.log('✅ Шаг 4 завершен!');

    // -------------------------------------------------------------
    // Шаг 5: Добавление товара и загрузка фото
    // -------------------------------------------------------------
    console.log('👉 Шаг 5: Добавление нового товара с фото...');
    await page.goto('http://localhost:5173/products/new');
    await page.waitForSelector('input[placeholder="W712, 04465-33471..."]');

    // Название, SKU, штрихкод
    await page.fill('input[placeholder="W712, 04465-33471..."]', 'TEST-PADS-100');
    await page.click('button:has-text("Генерувати")');
    await sleep(1000);
    await page.fill('input[placeholder="Фільтр оливний Mann W712"]', 'Колодки Brembo Carbon-XP');

    // Категория
    const catInput = page.locator('input[placeholder="Пошук або створити..."]').first();
    await catInput.click();
    await catInput.fill('Тормоза');
    await sleep(1000);
    const catCreateBtn = page.locator('button:has-text("+ Створити")');
    if (await catCreateBtn.isVisible()) {
      await catCreateBtn.click();
      console.log('   Категория "Тормоза" создана!');
    } else {
      await page.keyboard.press('Escape');
    }
    await sleep(500);

    // Бренд
    const brandInput = page.locator('input[placeholder="Пошук або створити..."]').nth(1);
    await brandInput.click();
    await brandInput.fill('Brembo-PRO');
    await sleep(1000);
    const brandCreateBtn = page.locator('button:has-text("+ Створити")');
    if (await brandCreateBtn.isVisible()) {
      await brandCreateBtn.click();
      console.log('   Бренд "Brembo-PRO" создан!');
    } else {
      await page.keyboard.press('Escape');
    }
    await sleep(500);

    // Цены
    await page.fill('input[placeholder="250.00"]', '900.00'); // Закупка
    await page.fill('input[placeholder="450.00"]', '1500.00'); // Розничная

    // Единица измерения
    await page.selectOption('select', 'компл');

    // Складской ящик
    await page.fill('input[placeholder="Стелаж A1 / Полиця 3"]', 'Ячейка A-12');

    // Загрузка фото
    if (existsSync(PHOTO_SOURCE_PATH)) {
      console.log('   Загружаем сгенерированное фото товара...');
      await page.setInputFiles('input[accept="image/*"]:not([capture])', PHOTO_SOURCE_PATH);
      await sleep(3000); // подождем загрузки и сжатия
    } else {
      console.log('⚠️ Предупреждение: сгенерированное фото не найдено по пути:', PHOTO_SOURCE_PATH);
    }

    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_5_product_form.png') });
    await page.click('button[type="submit"]');
    await page.waitForURL('**/products', { timeout: 10000 });
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_5_product_list.png') });
    console.log('✅ Шаг 5 завершен!');

    // Получим ID созданного товара из базы
    const productQuery = await dbClient.query("SELECT id FROM products WHERE sku IN ('TEST-PADS-100', 'TESTPADS100') ORDER BY created_at DESC LIMIT 1");
    const productId = productQuery.rows[0]?.id;
    console.log(`ℹ️ ID созданного товара: ${productId}`);

    // -------------------------------------------------------------
    // Шаг 6: Поставщики и Приходные накладные
    // -------------------------------------------------------------
    console.log('👉 Шаг 6: Создание поставщика и приходной накладной...');
    await page.goto('http://localhost:5173/suppliers');
    await page.waitForSelector('text=Постачальники');
    
    // Создаем поставщика, если его нет
    const supplierCheck = await dbClient.query("SELECT id FROM suppliers WHERE name = 'Автодистрибьютор Украина' LIMIT 1");
    let supplierId = supplierCheck.rows[0]?.id;
    if (!supplierId) {
      await page.goto('http://localhost:5173/suppliers/new');
      await page.waitForSelector('input[placeholder="Назва компанії"]');
      await page.fill('input[placeholder="Назва компанії"]', 'Автодистрибьютор Украина');
      await page.fill('input[placeholder="+380501234567"]', '+380509998877');
      await page.click('button[type="submit"]');
      await page.waitForURL('**/suppliers', { timeout: 10000 });
      const supplierQuery = await dbClient.query("SELECT id FROM suppliers WHERE name = 'Автодистрибьютор Украина' LIMIT 1");
      supplierId = supplierQuery.rows[0]?.id;
    }
    console.log(`ℹ️ ID поставщика: ${supplierId}`);

    // Создаем приходную накладную
    await page.goto('http://localhost:5173/suppliers/invoices/new');
    await page.waitForSelector('select');
    await page.selectOption('select', supplierId);

    // Заполним № накладной
    await page.fill('input[placeholder="Номер від постачальника"]', 'TEST-INV-123');
    
    // Добавим позицию
    await page.click('button:has-text("Додати товар")');
    await page.waitForSelector('input[placeholder="Пошук товарів за назвою..."]');
    await page.fill('input[placeholder="Пошук товарів за назвою..."]', 'TEST-PADS-100');
    await sleep(2000);
    // Клик по найденному товару Brembo Carbon-XP
    await page.click('button:has-text("Carbon-XP")');
    await sleep(1000);

    // Заполним количество в накладной
    await page.fill('input[step="0.001"]', '50'); // 50 штук
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_6_invoice_form.png') });
    
    // Сохранить накладную
    await page.click('button[type="submit"]');
    await page.waitForURL('**/suppliers/invoices', { timeout: 10000 });
    await sleep(2000);

    // Клик по сохраненной накладной по ее номеру TEST-INV-123
    await page.click('button:has-text("TEST-INV-123")');
    await page.waitForURL('**/suppliers/invoices/*', { timeout: 10000 });
    await sleep(1000);

    // Провести накладную
    await page.click('button:has-text("Провести")');
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_6_invoice_posted.png') });
    console.log('✅ Шаг 6 завершен!');

    // -------------------------------------------------------------
    // Шаг 7: Создание клиента
    // -------------------------------------------------------------
    console.log('👉 Шаг 7: Создание клиента...');
    await page.goto('http://localhost:5173/customers/new');
    await page.waitForSelector('input[placeholder="+380671234567"]');
    await page.fill('input[placeholder="Іваненко Іван Іванович"]', 'Дмитрий Telegram-Клиент');
    await page.fill('input[placeholder="+380671234567"]', '+380991112233');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/customers', { timeout: 10000 });
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_7_customer_list.png') });
    console.log('✅ Шаг 7 завершен!');

    const customerQuery = await dbClient.query("SELECT id FROM customers WHERE phone = '+380991112233' LIMIT 1");
    const customerId = customerQuery.rows[0]?.id;
    console.log(`ℹ️ ID клиента: ${customerId}`);

    // -------------------------------------------------------------
    // Шаг 8: Симуляция сообщения от Telegram-бота
    // -------------------------------------------------------------
    console.log('👉 Шаг 8: Симуляция входящего сообщения из Telegram...');
    // Получаем Telegram канал
    const channelQuery = await dbClient.query("SELECT id FROM messenger_channels WHERE platform = 'telegram' LIMIT 1");
    let channelId = channelQuery.rows[0]?.id;
    if (!channelId) {
      const channelInsert = await dbClient.query(
        "INSERT INTO messenger_channels (name, platform) VALUES ('Telegram Бот', 'telegram') RETURNING id"
      );
      channelId = channelInsert.rows[0]?.id;
    }

    // Создаем/обновляем чат
    const chatIdUuid = 'e0000000-0000-0000-0000-000000000001';
    await dbClient.query(`
      INSERT INTO messenger_chats (id, channel_id, platform_chat_id, username, first_name, phone, last_message_at, unread_count)
      VALUES ($1, $2, '123456789', 'tester_bot', 'Дмитрий Telegram-Клиент', '+380991112233', NOW(), 1)
      ON CONFLICT (id) DO UPDATE
      SET last_message_at = NOW(), unread_count = 1
    `, [chatIdUuid, channelId]);

    // Добавляем сообщение
    await dbClient.query(`
      INSERT INTO messenger_messages (chat_id, sender_type, text, created_at)
      VALUES ($1, 'customer', 'Здравствуйте! Хочу заказать Brembo Carbon-XP', NOW())
    `, [chatIdUuid]);

    await page.goto('http://localhost:5173/orders');
    await sleep(2000);
    // Клик по вкладке Чат в левой панели, если она есть
    await page.click('button:has-text("Дмитрий Telegram-Клиент")');
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_8_telegram_chat.png') });
    console.log('✅ Шаг 8 завершен!');

    // -------------------------------------------------------------
    // Шаг 9: Создание Черновика заказа (КП) из чата
    // -------------------------------------------------------------
    console.log('👉 Шаг 9: Создание черновика заказа (КП)...');
    // Привяжем клиента к чату через UI
    await page.fill('input[placeholder="Пошук по телефону / імені..."]', 'Дмитрий Telegram-Клиент');
    await sleep(1500);
    await page.click('div.border.border-gray-200.rounded-xl.overflow-hidden.shadow-sm button');
    await sleep(1000);

    // Открываем модальное окно заказа из чата
    await page.click('.border-yellow-200 button:has-text("Нове замовлення")');
    await page.waitForSelector('input[placeholder="Назва деталі *"]');
    
    await page.fill('input[placeholder="Назва деталі *"]', 'Колодки Brembo Carbon-XP');
    await page.fill('input.text-center', '1');
    await page.fill('input.text-right', '1500.00');

    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_9_quick_order_modal.png') });
    await page.click('button:has-text("Створити замовлення")');
    await sleep(4000); // подождем закрытия модалки и обновления списка

    // Кликаем по кнопке "Детальніше" в правой панели чата для перехода в заказ
    await page.click('.border-yellow-200 button:has-text("Детальніше")');
    await sleep(2000);

    // Теперь мы на странице заказа, получаем его ID из URL
    const url = page.url();
    const orderId = url.split('/').pop();
    console.log(`ℹ️ ID созданного заказа: ${orderId}`);

    // Привязываем созданную позицию к нашему реальному товару и меняем тип на warehouse в базе данных
    await dbClient.query(
      "UPDATE customer_order_items SET product_id = $1, source_type = 'warehouse', sku = 'TEST-PADS-100' WHERE order_id = $2",
      [productId, orderId]
    );
    console.log(`ℹ️ Связали товар ${productId} с заказом ${orderId} в БД как складской.`);
    
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_9_draft_created.png') });
    console.log('✅ Шаг 9 завершен!');

    // -------------------------------------------------------------
    // Шаг 10: Отправка КП в Telegram
    // -------------------------------------------------------------
    console.log('👉 Шаг 10: Отправка КП в Telegram...');
    // Перейдем в КП/Предложение
    await page.goto(`http://localhost:5173/quotes/${orderId}`);
    await page.waitForSelector('text=Надіслати КП в Telegram');
    await sleep(1000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_10_quote_editor.png') });
    await page.click('text=Надіслати КП в Telegram');
    await sleep(2000); // подождем отправки
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_10_quote_sent.png') });
    console.log('✅ Шаг 10 завершен!');

    // -------------------------------------------------------------
    // Шаг 11: Подтверждение заказа и Резервация товара
    // -------------------------------------------------------------
    console.log('👉 Шаг 11: Подтверждение заказа и резервирование...');
    await page.goto(`http://localhost:5173/quotes/${orderId}`);
    await page.waitForSelector('button:has-text("В замовлення")');
    await page.click('button:has-text("В замовлення")');
    await page.waitForURL(`**/orders/${orderId}`, { timeout: 10000 });
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_11_order_reserved.png') });
    console.log('✅ Шаг 11 завершен!');

    // -------------------------------------------------------------
    // Шаг 12: Сборка заказа на складе (WMS Picking)
    // -------------------------------------------------------------
    console.log('👉 Шаг 12: Сборка заказа на складе...');
    await page.goto('http://localhost:5173/inventory/picking');
    await page.waitForSelector('text=Складання замовлень');
    await sleep(1500);
    // Выберем наше замовлення и соберем
    await page.click(`text=#${orderId.slice(0, 6)}`);
    await sleep(1000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_12_picking_details.png') });
    
    // Клик по кнопке сборки
    await page.click('button:has-text("Зібрати")');
    await sleep(1000);

    // Заполним ячейку хранения
    await page.waitForSelector('input[placeholder="Наприклад: А-5, Полиця 2, Стіл"]');
    await page.fill('input[placeholder="Наприклад: А-5, Полиця 2, Стіл"]', 'Ячейка А-12');
    await page.click('button:has-text("Завершити збірку")');
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_12_picking_complete.png') });
    console.log('✅ Шаг 12 завершен!');

    // -------------------------------------------------------------
    // Шаг 13: Открытие смены в POS
    // -------------------------------------------------------------
    console.log('👉 Шаг 13: Открытие смены в POS...');
    await page.goto('http://localhost:5173/pos');
    await sleep(2000);
    
    // Если смена закрыта, откроем ее
    const openShiftBtn = page.locator('button:has-text("Відкрити зміну")');
    if (await openShiftBtn.isVisible()) {
      await page.fill('input[placeholder="0.00 ₴"]', '1200.00');
      await openShiftBtn.click();
      await sleep(2000);
    }
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_13_pos_ready.png') });
    console.log('✅ Шаг 13 завершен!');

    // -------------------------------------------------------------
    // Шаг 14: Продажа зарезервированного заказа на POS
    // -------------------------------------------------------------
    console.log('👉 Шаг 14: Продажа зарезервированного заказа...');
    // Выберем клиента
    await page.click('button:has-text("Клієнт")');
    await sleep(500);
    await page.fill('input[placeholder="Пошук клієнта..."]', 'Дмитрий Telegram-Клиент');
    await sleep(1500);
    await page.click('button:has-text("Дмитрий Telegram-Клиент")');
    await sleep(1000);

    // Подгрузка active заказа клиента в POS
    await page.click('button:has-text("Видати")'); // открываем панель готовых заказов
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_14_load_order.png') });
    
    // Кликаем по кнопке "У кошик" внутри строки заказа нашего клиента
    await page.click('div:has-text("Дмитрий Telegram-Клиент") >> button:has-text("У кошик")');
    await sleep(1500);

    // Клик Оплата
    await page.click('#pos-pay-btn');
    await page.waitForSelector('button:has-text("ПІДТВЕРДИТИ")');
    await sleep(1000);
    
    // Заполним полученную сумму наличных (1500 грн)
    await page.fill('input[placeholder="0.00"]', '1500.00');
    await sleep(1000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_14_payment_modal.png') });
    
    // Клик подтвердить оплату наличными
    await page.click('button:has-text("ПІДТВЕРДИТИ")');
    await sleep(2500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_14_sale_complete.png') });
    console.log('✅ Шаг 14 завершен!');

    // -------------------------------------------------------------
    // Шаг 15: Возврат товара (Returns)
    // -------------------------------------------------------------
    console.log('👉 Шаг 15: Оформление возврата товара...');
    await page.goto('http://localhost:5173/sales');
    await page.waitForSelector('text=Журнал продажів');
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_15_sales_journal.png') });

    // Оформим возврат
    await page.goto('http://localhost:5173/returns');
    await page.waitForSelector('input[placeholder="Номер чека (напр. 000001)"]');
    // Поищем последний чек в базе
    const saleQuery = await dbClient.query("SELECT sale_number FROM sales ORDER BY created_at DESC LIMIT 1");
    const saleNumber = saleQuery.rows[0]?.sale_number;
    console.log(`ℹ️ Номер последнего чека: ${saleNumber}`);
    
    await page.fill('input[placeholder="Номер чека (напр. 000001)"]', String(saleNumber));
    await page.click('button:has-text("Знайти")');
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_15_return_form.png') });

    // Клик по кнопке возврата всего (выбрать все позиции)
    const selectAllBtn = page.locator('button:has-text("Всі")').first();
    if (await selectAllBtn.isVisible()) {
      await selectAllBtn.click();
    } else {
      await page.click('button:has-text("Повернути все")');
    }
    await sleep(500);

    // Переходим на Шаг 3 (Причина и оплата)
    await page.click('button:has-text("Далі:")');
    await sleep(500);

    // Выбираем причину "Inshe" и заполняем
    await page.click('input[value="other"]');
    await sleep(500);
    await page.fill('input[placeholder="Опишіть причину..."]', 'Тестовый возврат 1 шт');
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_15_return_details.png') });

    // Подтверждаем возврат
    await page.click('button[type="submit"]');
    await sleep(2500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_15_return_complete.png') });
    console.log('✅ Шаг 15 завершен!');

    // -------------------------------------------------------------
    // Шаг 16: Списание брака и Инвентаризация
    // -------------------------------------------------------------
    console.log('👉 Шаг 16: Списание брака и инвентаризация...');
    // Списание
    await page.goto('http://localhost:5173/inventory/writeoffs/new');
    await page.waitForSelector('input[placeholder="Пошук товару для списання..."]');
    await page.fill('input[placeholder="Пошук товару для списання..."]', 'TEST-PADS-100');
    await sleep(1500);
    await page.click('button:has-text("Carbon-XP")');
    await sleep(500);
    await page.fill('table input[type="number"]', '1'); // списать 1 шт
    await page.fill('textarea', 'Брак упаковки (Тест)');
    await page.click('button:has-text("Створити акт списання")');
    await page.waitForURL('**/inventory/writeoffs/*', { timeout: 10000 });
    await sleep(1500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_16_writeoff_complete.png') });

    // Инвентаризация
    await page.goto('http://localhost:5173/inventory');
    await page.waitForSelector('text=Інвентаризація');
    await sleep(1000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_16_inventory_list.png') });
    console.log('✅ Шаг 16 завершен!');

    // -------------------------------------------------------------
    // Шаг 17: Зарплаты и Комиссии сотрудников
    // -------------------------------------------------------------
    console.log('👉 Шаг 17: Управление персоналом и зарплаты...');
    await page.goto('http://localhost:5173/staff-salary');
    await page.waitForSelector('text=Нарахування зарплати');
    await page.click('button:has-text("Нарахування")');
    await page.waitForSelector('select');
    
    // Выберем сотрудника и тип "Бонус"
    const selects = page.locator('select');
    await selects.nth(0).selectOption({ index: 1 });
    await selects.nth(1).selectOption('bonus');
    await sleep(500);

    // Заполняем сумму и примечание
    await page.fill('input[placeholder="5000"]', '3000.00');
    await page.fill('textarea[placeholder="За що нараховано..."]', 'Премия за успешный автотест 19 шагов');
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_17_salary_modal.png') });
    await page.click('button:has-text("Зберегти")');
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_17_salary_complete.png') });
    console.log('✅ Шаг 17 завершен!');

    // -------------------------------------------------------------
    // Шаг 18: Аналитика и Отчеты
    // -------------------------------------------------------------
    console.log('👉 Шаг 18: Проверка аналитики и отчетов...');
    await page.goto('http://localhost:5173/reports');
    await page.waitForSelector('text=Виручка');
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_18_daily_report.png') });

    await page.goto('http://localhost:5173/abc');
    await page.waitForSelector('text=ABC-аналіз товарів');
    await sleep(2000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_18_abc_analysis.png') });
    console.log('✅ Шаг 18 завершен!');

    // -------------------------------------------------------------
    // Шаг 19: Закрытие кассовой смены
    // -------------------------------------------------------------
    console.log('👉 Шаг 19: Закрытие кассовой смены...');
    await page.goto('http://localhost:5173/pos');
    await page.waitForSelector('button[title="Закрити зміну"]');
    await page.click('button[title="Закрити зміну"]');
    await page.waitForSelector('h2:has-text("Закрити зміну")');
    await sleep(1000);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_19_shift_close_modal.png') });

    // Закрываем смену
    await page.fill('.relative input[type="number"]', '1200.00'); // ввели фактический остаток
    await page.click('.relative button:has-text("Закрити зміну")');
    await sleep(2500);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_19_shift_closed.png') });
    console.log('✅ Шаг 19 завершен!');

  } catch (err) {
    console.error('❌ Ошибка во время выполнения теста:', err);
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot_error.png') });
  } finally {
    await browser.close();
    await dbClient.end();
    console.log('🏁 Тестирование завершено! Скрипты отработали.');
  }
}

run();
