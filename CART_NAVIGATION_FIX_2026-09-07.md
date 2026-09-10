# Current receipt and recovery copy

The POS page previously offered every saved snapshot on every mount, including
the receipt already retained by the in-memory POS store during navigation.

Recovery now excludes operation IDs already present in live receipt tabs and
deduplicates saved operation IDs. Product identity is deliberately not used:
different legitimate receipts can contain the same products.
The restore action checks again to avoid duplicates on retry.

Normal navigation leaves the current receipt in the basket with no recovery
banner for that receipt. Genuine missing crash backups can still be recovered.
Autosave pauses while such recovery is pending so an empty new basket cannot
erase the backup. Current state is flushed on navigation/unload, including when
leaving before the 180ms debounce finishes.

Five regression tests cover live receipts, stale snapshots, genuine recovery,
distinct receipts with identical products and duplicate/retry handling.
No working sale or stock data was modified. Executable rebuild is pending.
