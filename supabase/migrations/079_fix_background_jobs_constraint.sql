-- PL-09: CHECK constraint на sys_background_jobs.status
-- Запобігає вставці невідомих статусів, які зависали б назавжди

-- Виправлено: 'completed' відповідає jobWorker.handleSuccess
ALTER TABLE sys_background_jobs
  ADD CONSTRAINT chk_bg_jobs_status
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));
