# Cashier customer discounts — 2026-09-15

- Cashiers can set personal discounts when creating or editing a customer, including quick editing from POS search.
- Desktop IPC verifies the persisted loyalty mode. Cashiers cannot change cashback accrual rates, bonus balances, price groups or other protected financial settings.
- Price-group priority remains unchanged and is explained in quick editing.
- Regression coverage checks permission separation, local persistence, barcode lookup, invalid percentages and absence of sales/bonus side effects.

## Verification

- Type checks for web, desktop, server and API; web lint passed.
- Web: 481 tests passed. Desktop: 422 tests passed.
- Server: 275 tests passed on a serial rerun. The first parallel run hit a Windows worker spawn failure during packaging, not an assertion failure.
- Electron local DB smoke test passed against a temporary database.
- Existing portable EXE rebuilt in place; existing desktop shortcut target verified. No live stock or financial records modified.
- EXE SHA256: C6594DF6EC9090F2D47371DE094C5E9AF0E36AEEB4ECBDCDB83781111D9F003B.
