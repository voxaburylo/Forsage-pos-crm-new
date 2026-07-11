# Forsage Desktop

Каркас локальної portable-версії Forsage.

## Що вже є

- один екземпляр програми на ПК;
- вбудований у Electron/Node SQLite без окремого нативного модуля у
  `%LOCALAPPDATA%\Forsage\data\forsage.db`;
- WAL, foreign keys, повна синхронність запису та перевірка цілісності;
- версійні локальні міграції;
- довічний `device_id` цього ПК;
- транзакційний `sync_outbox` і локальний журнал дій;
- ручна резервна копія через захищений IPC;
- локальна схема v2 для товарів, штрихкодів, клієнтів, авто, змін, чеків,
  оплат, касових операцій, рухів складу та інвентаризації;
- атомарна локальна POS-транзакція: чек, рядки, оплата, списання залишку,
  рух складу, outbox та audit log;
- захищені IPC-команди для локального каталогу та POS:
  `catalog.findByBarcode`, `catalog.searchProducts`, `pos.openShift`,
  `pos.checkout`;
- portable-збірка `Forsage-<version>-portable.exe`.

Поточний React-інтерфейс вбудовується без копіювання його вихідного коду.
До перемикання стара веб-каса продовжує працювати. Наступний крок -
під'єднати POS UI до `window.forsageDesktop` в desktop/PWA режимі та додати
фоновий sync worker для відправки `sync_outbox` у Supabase.

## Перевірка

```bash
pnpm --filter=desktop smoke:db
```

Smoke-test створює тимчасову базу в `C:\tmp`, додає товар зі штрихкодом,
відкриває зміну, проводить продаж, перевіряє outbox і робить backup.
