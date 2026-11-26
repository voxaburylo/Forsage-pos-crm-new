-- 26.11.2026, слово власника (запит сайту forsage-tires.com): «функція site_supplier_offers_export(p_token, p_since,
-- p_after_id, p_limit) — так само, як site_catalog_export, з тим самим токеном і посторінковою видачею; рядки
-- site_supplier_offers: external_id, number, brand, name, barcode, image_url, category_id, retail_price (у копійках, лише
-- роздрібна, без закупівельної), supplier_qty, min_days_to_ship, updated_at; сортування updated_at, потім external_id.
-- І в site_catalog_export додай поле lead_days для товарів магазину».
--
-- Ті самі поля й ті самі формули, що у view site_supplier_offers, але з таблиці supplier_offers і з ознакою active:
-- view показує лише наявне й не приховане, тож товар, що зник чи прибраний із сайту, інакше ніколи не прийшов би
-- оновленням — сайт тримав би його вічно. active=false — прибрати з продажу (як active у site_catalog_export).
-- Закупівельна ціна, склади поіменно й ключі постачальників не віддаються.

CREATE INDEX IF NOT EXISTS idx_supplier_offers_updated_external ON public.supplier_offers (updated_at, external_id);

CREATE OR REPLACE FUNCTION public.site_supplier_offers_export(
  p_token text,
  p_since timestamptz DEFAULT '1970-01-01 00:00:00+00',
  p_after_id text DEFAULT '',
  p_limit integer DEFAULT 1000
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
-- Read-only export for the website: supplier offers (Omega, GPL). Retail price only, in kopecks.
declare v_rows jsonb;
begin
  -- Той самий токен, що й у site_catalog_export.
  if p_token is null or encode(extensions.digest(p_token, 'sha256'), 'hex') <> '72b8bf09277cb40c65111de3437df7f30f4958f79dd48475448158fd6b6b0b20' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(r order by r.updated_at, r.external_id), '[]'::jsonb) into v_rows from (
    select o.external_id, o.number, o.brand,
           coalesce(o.custom_name, o.name) as name,
           coalesce(o.custom_barcode, o.barcode) as barcode,
           o.image_url, o.category_id,
           coalesce(o.custom_price, o.retail_price) as retail_price,
           o.total_qty as supplier_qty,
           (select min(w.days_to_ship) from jsonb_array_elements(o.stock) s(value)
              join supplier_warehouses w on w.connection_id = o.connection_id and w.code = (s.value ->> 'w') and w.is_active
             where (s.value ->> 'q')::integer > 0) as min_days_to_ship,
           o.updated_at,
           (c.enabled and o.total_qty > 0 and not o.hidden) as active
      from supplier_offers o
      join supplier_api_connections c on c.id = o.connection_id
     where (o.updated_at, o.external_id) > (coalesce(p_since, '1970-01-01 00:00:00+00'::timestamptz), coalesce(p_after_id, ''))
     order by o.updated_at, o.external_id
     limit least(greatest(coalesce(p_limit, 1000), 1), 2000)
  ) r;
  return jsonb_build_object('offers', v_rows);
end $function$;

REVOKE ALL ON FUNCTION public.site_supplier_offers_export(text, timestamptz, text, integer) FROM PUBLIC;
-- Ті самі права, що в site_catalog_export: anon (сайт іде з анонімним ключем + токен) і service_role.
GRANT EXECUTE ON FUNCTION public.site_supplier_offers_export(text, timestamptz, text, integer) TO anon, service_role;

-- site_catalog_export: усе як було (той самий токен, поля, посторінковість) + lead_days для товарів магазину:
-- 0 — є на складі магазину (відправка сьогодні), null — немає (строк невідомий). Окремого поля строку в картці немає.
CREATE OR REPLACE FUNCTION public.site_catalog_export(p_token text, p_since timestamp with time zone DEFAULT '1970-01-01 00:00:00+00'::timestamp with time zone, p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid, p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
-- Read-only export for the website (forsage-tires.com). Public catalog fields only (no purchase/wholesale/min prices).
declare v_rows jsonb; v_cats jsonb;
begin
  if p_token is null or encode(extensions.digest(p_token, 'sha256'), 'hex') <> '72b8bf09277cb40c65111de3437df7f30f4958f79dd48475448158fd6b6b0b20' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(r order by r.updated_at, r.id), '[]'::jsonb) into v_rows from (
    select p.id, p.updated_at, p.sku, p.name, p.barcode, p.oem_number, p.unit, p.retail_price, p.qty_on_hand,
           (p.is_active and p.deleted_at is null and coalesce(p.is_service, false) = false) as active,
           p.category_id, b.name as brand, p.photo_url, p.specs,
           (select coalesce(jsonb_agg(ph.url order by ph.sort_order), '[]'::jsonb) from product_photos ph where ph.product_id = p.id) as photos,
           array_remove(array(
             select distinct x from (
               select upper(regexp_replace(coalesce(cn.number, ''), '[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ]', '', 'g')) x from product_cross_numbers cn where cn.product_id = p.id and cn.deleted_at is null
               union all
               select upper(regexp_replace(coalesce(pb.barcode, ''), '[^0-9A-Za-z]', '', 'g')) from product_barcodes pb where pb.product_id = p.id and pb.deleted_at is null
               union all
               select upper(regexp_replace(coalesce(v, ''), '[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ]', '', 'g')) from unnest(array[p.sku, p.barcode, p.oem_number, p.normalized_oem, p.normalized_supplier_article]) v
             ) t where length(x) >= 3 and x not like 'AUTO%'
           ), null) as numbers,
           (case when p.qty_on_hand > 0 then 0 end) as lead_days
    from products p left join brands b on b.id = p.brand_id
    where (p.updated_at, p.id) > (p_since, p_after_id)
    order by p.updated_at, p.id limit least(greatest(p_limit, 1), 2000)
  ) r;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'parent_id', c.parent_id, 'sort_order', c.sort_order)), '[]'::jsonb)
    into v_cats from categories c where c.deleted_at is null;
  return jsonb_build_object('products', v_rows, 'categories', v_cats);
end $function$;
