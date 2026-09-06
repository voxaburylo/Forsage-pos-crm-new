# Як воно потрапляє до магазину

Три частини оновлюються по-різному. Плутанина тут дорого коштує: одного разу
каса два дні працювала зі старої збірки, і сотня продажів мовчки не доїхала на
сервер.

## Веб і бекенд — самі, після `git push`

| Що | Куди | Як |
|---|---|---|
| Бекенд (`server/`) | https://forsage-pos-crm-new.onrender.com | Render, `autoDeploy: true` з гілки `main` (`render.yaml`) |
| Веб-інтерфейс (`apps/web`) | https://forsage-pos-crm-new-web.vercel.app | Vercel з `main` (`vercel.json`) |
| Хмарна база | Supabase `zuhanlspejgizjbwbnda` | міграції з `supabase/migrations` застосовуються окремо |

Vercel заразом піднімає `/api/v1/*` як serverless-функцію (`api/index.ts` — це
той самий Express із `server/src`, лише інша точка входу). Тобто бекенд живе у
двох місцях; робочий для каси — Render.

**Отже: `git push origin main` — і за кілька хвилин веб та бекенд оновлені.**
Перевірити: https://forsage-pos-crm-new.onrender.com/api/v1/health має віддати 200.

## Каса — руками, однією командою

```bash
pnpm --filter=desktop dist
```

Збирає `apps/desktop/release/Forsage-0.1.0-portable.exe`. **Копіювати нікуди не
треба:** ярлик «ФОРСАЖ — КАСА» на робочому столі веде прямо на цей файл, тому
наступний запуск підхопить нову версію сам.

Власник свідомо відмовився від авто-оновлення (06.09.2026) — оновлює сам.

**Перед перезбіркою каса має бути закрита**, інакше файл зайнятий.

### Перевірка, що каса справді нова

```sql
-- у %LOCALAPPDATA%\Forsage\data\forsage.db
SELECT MAX(version) FROM schema_migrations;
```

Має збігатися з останньою міграцією в `apps/desktop/src/db/schema.ts`. Якщо
менше — запущено стару збірку. Свіжа збірка на новішій базі не стартує і сама
про це скаже.

## Перед деплоєм

```bash
pnpm --filter=server typecheck && pnpm --filter=server test
pnpm --filter=web typecheck && pnpm --filter=web lint && pnpm --filter=web test
pnpm --filter=desktop typecheck && pnpm --filter=desktop test
```

## Змінні середовища

Ключі Supabase і адреси API вшиті у `vercel.json` (для збірки веба) та в
налаштуваннях Render. Локальні ключі — у `server/.env`, у git їх немає.

Старий опис розгортання на власному сервері через PM2 лежить у
`docs/archive/DEPLOY_pm2.md` — він більше не описує дійсність.
