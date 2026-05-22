# Розгортання CRM-Forsage в Production

## Вимоги

- Node.js 20+
- PM2 (`npm i -g pm2`)
- Supabase project (активний)

---

## 1. Підготовка змінних середовища

```bash
cp server/.env.example server/.env
cp apps/web/.env.example apps/web/.env
```

Заповнити всі значення у `server/.env` і `apps/web/.env`.

**Обов'язкові:**
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — з Supabase → Settings → API
- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` — анонімний ключ
- `VITE_API_URL` — публічний URL вашого сервера (напр. `https://api.yoursite.com`)
- `CORS_ORIGIN` — URL фронтенду (напр. `https://yoursite.com`)
- `TELEGRAM_BOT_TOKEN` — якщо потрібен Telegram-бот

---

## 2. Міграції бази даних

Всі міграції (001–084) повинні бути застосовані через Supabase MCP або CLI.

Перевірити список застосованих міграцій:
```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
```

---

## 3. Перший запуск (seed)

Якщо база нова — запустити seed для створення власника:

```bash
cd server
SEED_OWNER_PHONE=+380XXXXXXXXX SEED_OWNER_PASSWORD=yourpassword npx ts-node src/seed.ts
```

---

## 4. Збірка і запуск

```bash
# Build server
cd server && npm run build && cd ..

# Build frontend
cd apps/web && npm run build && cd ..

# Запустити PM2
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # авто-запуск при перезавантаженні
```

---

## 5. Nginx (proxy)

```nginx
# /etc/nginx/sites-available/crm-forsage

server {
    listen 80;
    server_name yoursite.com;

    # Frontend (статика)
    root /path/to/crm-forsage/apps/web/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 6. Feature flags (рекомендовані для prod)

```env
USE_RESERVE_AWARE_SALE=true   # process_sale_v2
USE_BONUS_ATOMIC_SALE=true    # process_sale_v3
USE_ATOMIC_COMPLETION=true    # complete_customer_order
```

---

## 7. Оновлення (rolling update)

```bash
git pull
cd server && npm run build && cd ..
cd apps/web && npm run build && cd ..
pm2 restart crm-forsage-api
```
