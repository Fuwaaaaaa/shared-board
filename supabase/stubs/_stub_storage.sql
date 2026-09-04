-- =============================================================================
--  テスト用の storage スタブ
-- -----------------------------------------------------------------------------
--  supabase/postgres のイメージだけを起動した場合、storage スキーマは空です
--  （buckets / objects と storage.foldername は Storage サービス側の
--   マイグレーションで作られるため）。
--
--  schema.sql の末尾はそれらを前提にしているので、テストで丸ごと流せるように
--  最小限の形だけ用意します。本番の Supabase では不要です。
--
--  あわせて、合言葉のハッシュ化に使う pgcrypto を extensions スキーマに入れます。
--  supabase/postgres のイメージなら最初から入っているので何も起きません。
--  素の Postgres（postgres:17 など）で試すときは、この 2 行が無いと schema.sql の
--  §1.5 で止まります（auth.uid() など他にも足りないものがあるので、素の Postgres は
--  おすすめしません）。
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text not null,
  owner     uuid
);

alter table storage.objects enable row level security;

-- 本物と同じく、パスを「/」で区切って配列にする
create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select string_to_array(name, '/');
$$;

grant usage on schema storage to anon, authenticated, service_role;
-- 本物の Supabase と同じく、可否は RLS のポリシーだけで決まるようにする
-- （テーブルへの権限まで無いと、ポリシーが効いているのか権限が無いだけなのか
--   区別が付かず、Storage のポリシーを確かめられない）。
grant select, insert, update, delete on storage.objects to anon, authenticated;

-- テストでは schema.sql を postgres で流すので、バケットとオブジェクトの持ち主も
-- postgres にしておく。create policy はテーブルの持ち主にしかできないため、
-- これが無いと schema.sql の §7 が丸ごと「スキップしました」の警告で素通りし、
-- Storage の権限（貼れるのは編集できる人だけ、読めるのは参加者）を
-- テストで確かめられない。本番では Storage サービスが持ち主なので不要。
alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
