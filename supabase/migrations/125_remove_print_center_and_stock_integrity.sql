-- Повне видалення невикористовуваного центру друку та перевірки від'ємних залишків.

DELETE FROM sys_background_jobs
WHERE job_type = 'validate_stock_integrity';

DELETE FROM audit_log
WHERE action = 'stock_integrity_check';

DROP FUNCTION IF EXISTS validate_stock_integrity(UUID);
DROP TABLE IF EXISTS print_jobs;

NOTIFY pgrst, 'reload schema';
