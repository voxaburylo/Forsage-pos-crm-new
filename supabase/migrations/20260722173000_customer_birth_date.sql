-- Optional customer birthday used by the desktop and web customer card.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS birth_date DATE;

NOTIFY pgrst, 'reload schema';
