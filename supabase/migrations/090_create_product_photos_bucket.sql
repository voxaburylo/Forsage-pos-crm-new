-- 090_create_product_photos_bucket.sql
-- Створюємо Supabase Storage bucket для фото товарів
-- Якщо bucket вже існує — нічого не робимо

-- Створюємо bucket 'product-photos' (якщо не існує)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-photos',
  'product-photos',
  true,
  5242880, -- 5MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/heic']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- RLS: дозволяємо публічне читання (щоб фото завантажувались)
DROP POLICY IF EXISTS "product_photos_select" ON storage.objects;
CREATE POLICY "product_photos_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-photos');

-- RLS: дозволяємо завантаження аутентифікованим користувачам
DROP POLICY IF EXISTS "product_photos_insert" ON storage.objects;
CREATE POLICY "product_photos_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'product-photos'
    AND auth.role() = 'authenticated'
  );

-- RLS: дозволяємо видалення аутентифікованим користувачам
DROP POLICY IF EXISTS "product_photos_delete" ON storage.objects;
CREATE POLICY "product_photos_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'product-photos'
    AND auth.role() = 'authenticated'
  );
