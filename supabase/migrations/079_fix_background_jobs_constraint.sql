-- PL-09: CHECK constraint на sys_background_jobs.status
-- Запобігає вставці невідомих статусів, які зависали б назавжди

ALTER TABLE sys_background_jobs
  ADD CONSTRAINT chk_bg_jobs_status
  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled'));
