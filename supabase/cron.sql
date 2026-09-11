-- =============================================================================
--  定期実行（pg_cron）の設定
-- -----------------------------------------------------------------------------
--  プッシュ通知の送信（send-reminders）、Storage の実体の掃除（purge-storage）、
--  古い記録の掃除をまとめて登録します。
--
--  ■ 実行する前に、下の 1 か所を自分のプロジェクトの値に置き換えてください。
--    <PROJECT_REF>  … Project Settings → General の Reference ID
--
--  ■ service_role キーはここには書きません。
--    Edge Function を呼ぶときの合言葉はこの SQL が自動生成し、Vault（vault.secrets）に
--    暗号化して保存します。cron のジョブ本文（cron.job テーブル）にも残りません。
--
--  ■ 実行したあと、生成された合言葉を Edge Function 側にも同じ値で設定してください:
--      select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret';
--      npx supabase secrets set CRON_SHARED_SECRET=<その値>
--    手順は docs/SETUP.md「プッシュ通知」を参照してください。
--
--  ■ 合言葉を入れ替えたいときは、次を実行してから Edge Function 側も設定し直します:
--      select vault.update_secret(
--        (select id from vault.secrets where name = 'cron_shared_secret'),
--        encode(extensions.gen_random_bytes(32), 'hex'));
--
--  ※ service_role キーはブラウザにも SQL Editor の履歴にも残さないでください。
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vault は新しいプロジェクトでは最初から有効。古いプロジェクトで無効なら有効にする。
-- 有効にできなくても、下で「Vault に鍵がありません」と分かるので、ここでは止めない。
do $$
begin
  create extension if not exists supabase_vault;
exception
  when others then
    raise warning 'supabase_vault を有効にできませんでした (%): %。Database → Extensions から有効にしてください。',
      sqlstate, sqlerrm;
end;
$$;

-- 鍵と URL を Vault に入れる（無ければ作る。あれば触らない）
do $$
declare
  v_base text := 'https://<PROJECT_REF>.supabase.co/functions/v1';
begin
  if not exists (select 1 from vault.secrets where name = 'functions_base_url') then
    if v_base like '%<PROJECT_REF>%' then
      raise exception 'cron.sql の <PROJECT_REF> を自分の値に置き換えてから実行してください';
    end if;
    perform vault.create_secret(v_base, 'functions_base_url',
      'Edge Functions のベース URL（https://<ref>.supabase.co/functions/v1）');
  end if;

  -- Edge Function を呼ぶときの合言葉。ここで自動生成する（貼り付ける値はありません）。
  -- 生成した値は、このあと Edge Function 側の secrets にも同じものを入れてください:
  --   select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret';
  --   npx supabase secrets set CRON_SHARED_SECRET=<その値>
  if not exists (select 1 from vault.secrets where name = 'cron_shared_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'cron_shared_secret',
      'pg_cron から Edge Functions を呼ぶときの合言葉（CRON_SHARED_SECRET）');
  end if;
end;
$$;

-- Edge Function を呼ぶ。合言葉は実行のたびに Vault から読む。
-- security definer なのは、vault.decrypted_secrets を読めるのが postgres だけのため。
-- 実行権限は取り上げる（authenticated から呼べると、任意の関数を合言葉付きで叩ける）。
--
-- ここで service_role キーを送らないのには理由がある。
-- pg_net はリクエストを net.http_request_queue（headers jsonb を含む）にいったん
-- 積んでから送るので、送ったヘッダは平文で DB のテーブルに残る。毎分の実行で
-- service_role キーを流していると、そのテーブルが読める経路が 1 つでもあれば
-- 全 RLS が無効化されるのと同じことになる。
-- 専用の合言葉なら、漏れても「この 2 つの関数を叩ける」だけで済む。
--
-- Authorization ヘッダも付けない。JWT の検証は supabase/config.toml で
-- verify_jwt = false と宣言しているため、ゲートウェイでは要求されない。
create or replace function public.cron_call_function(p_name text)
returns bigint
language plpgsql security definer
set search_path = '' as $$
declare
  v_secret text;
  v_base   text;
  v_id     bigint;
begin
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'cron_shared_secret';
  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'functions_base_url';

  if v_secret is null or v_base is null then
    raise exception 'Vault に cron_shared_secret / functions_base_url がありません（cron.sql を確認してください）';
  end if;

  select net.http_post(
    url     := rtrim(v_base, '/') || '/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', v_secret
               ),
    body    := '{}'::jsonb
  ) into v_id;

  return v_id;
end;
$$;

revoke execute on function public.cron_call_function(text) from public, anon, authenticated;

-- pg_net の内部テーブルについて。
--
-- pg_net は送信前のリクエストを net.http_request_queue にいったん積む。headers 列も
-- そのまま入るので、ここに service_role キーを流していると、毎分そのキーが平文で
-- DB のテーブルに現れることになる。
--
-- そして Supabase の既定では、このテーブルと net スキーマは PUBLIC に開いている
-- （下の確認 SQL で分かる）。しかもその権限を付けたのは supabase_admin なので、
-- SQL Editor（postgres として動く）からは revoke できない ——
-- 「自分が付けていない権限は剥がせない」ため、revoke は黙って何もしない。
--
-- だからこの実装では、送るものを service_role キーではなく専用の合言葉にしてある。
-- 読まれても「この 2 つの Edge Function を叩ける」だけで、DB の中身には届かない。
-- （PostgREST は net スキーマを公開しないので、ブラウザから直接読む経路も無い。
--   ここで守っているのは「DB に直接つなげる人が現れたとき」の被害の大きさ）
--
-- 剥がせる環境なら剥がしておく。剥がせなくても上のとおり致命的ではない。
do $$
begin
  -- もともと権限が無い列ごとに「revoke するものがありません」と警告が出て
  -- 数十行になるので、この間だけ黙らせる。
  set local client_min_messages = error;

  revoke all on all tables in schema net from anon, authenticated;
  revoke all on all functions in schema net from anon, authenticated;
  revoke usage on schema net from anon, authenticated;
exception
  when others then null;   -- 剥がせない環境が既定。ここで止めない
end;
$$;

-- いまどうなっているかを表示する（false なら閉じている。true でも上のとおり想定内）
do $$
declare
  v_readable boolean := false;
begin
  select has_table_privilege('authenticated', 'net.http_request_queue', 'SELECT')
    into v_readable;
  if v_readable then
    raise notice 'net.http_request_queue は authenticated から読める状態です（Supabase の既定）。送っているのは専用の合言葉なので、読まれても DB の中身には届きません。';
  end if;
exception
  when undefined_table or invalid_schema_name then null;
end;
$$;


-- =============================================================================
--  ジョブ。既存のスケジュールがあれば消してから作り直す（何度流しても同じ状態になる）
-- =============================================================================

-- プッシュ通知の送信（毎分）
select cron.unschedule('send-board-reminders')
 where exists (select 1 from cron.job where jobname = 'send-board-reminders');

select cron.schedule(
  'send-board-reminders',
  '* * * * *',
  $$ select public.cron_call_function('send-reminders'); $$
);

-- Storage の実体の掃除（毎時 7 分）
-- 画像・添付の行を消したときやボードを消したときに purge_queue へ積まれたものを消す。
select cron.unschedule('purge-storage')
 where exists (select 1 from cron.job where jobname = 'purge-storage');

select cron.schedule(
  'purge-storage',
  '7 * * * *',
  $$ select public.cron_call_function('purge-storage'); $$
);

-- 送信済み台帳が無限に増えないよう、古い記録を毎日掃除する
select cron.unschedule('cleanup-reminder-sends')
 where exists (select 1 from cron.job where jobname = 'cleanup-reminder-sends');

select cron.schedule(
  'cleanup-reminder-sends',
  '17 4 * * *',                   -- 毎日 4:17
  $$ delete from public.reminder_sends where sent_at < now() - interval '14 days'; $$
);

-- 変更履歴も古いものは消す（90 日ぶん残す）
select cron.unschedule('cleanup-activities')
 where exists (select 1 from cron.job where jobname = 'cleanup-activities');

select cron.schedule(
  'cleanup-activities',
  '23 4 * * *',
  $$ delete from public.activities where created_at < now() - interval '90 days'; $$
);

-- ゴミ箱を空にする（30 日より古い削除済みを本当に消す。画像の実体は purge_queue 経由で消える）
select cron.unschedule('cleanup-trash')
 where exists (select 1 from cron.job where jobname = 'cleanup-trash');

select cron.schedule(
  'cleanup-trash',
  '31 4 * * *',                   -- 毎日 4:31
  $$
  delete from public.notes  where deleted_at < now() - interval '30 days';
  delete from public.events where deleted_at < now() - interval '30 days';
  delete from public.todos  where deleted_at < now() - interval '30 days';
  delete from public.images where deleted_at < now() - interval '30 days';
  delete from public.frames      where deleted_at < now() - interval '30 days';
  delete from public.connectors  where deleted_at < now() - interval '30 days';
  -- 手描きは 30 日を待たずに消えることがある。上限 2500 本はゴミ箱の行も
  -- 含めた合計なので、描き足して天井に当たると古い行から席を譲る
  -- （schema.sql の tg_limit_rows_per_room の 'yield'）。ここはその残りを掃く。
  delete from public.strokes     where deleted_at < now() - interval '30 days';
  -- 添付の DELETE は tg_enqueue_purge が purge_queue に積み、
  -- 毎時の purge-storage が Storage の実体を消す。ここで初めて実体が消える
  -- （ゴミ箱に入っているあいだは、行がまだ path を参照しているので消えない）。
  delete from public.attachments where deleted_at < now() - interval '30 days';
  $$
);

-- サイト内通知（既読は 30 日、未読でも 90 日で消す）
select cron.unschedule('cleanup-notifications')
 where exists (select 1 from cron.job where jobname = 'cleanup-notifications');

select cron.schedule(
  'cleanup-notifications',
  '41 4 * * *',
  $$
  delete from public.notifications
   where (read and created_at < now() - interval '30 days')
      or created_at < now() - interval '90 days';
  $$
);

-- 保存した状態（ボードごとに新しい 10 件だけ残す。画面側の KEEP と同じ数）
select cron.unschedule('cleanup-snapshots')
 where exists (select 1 from cron.job where jobname = 'cleanup-snapshots');

select cron.schedule(
  'cleanup-snapshots',
  '43 4 * * *',
  $$
  delete from public.snapshots s
   using (
     select id, row_number() over (partition by room_id order by created_at desc) as rn
       from public.snapshots
   ) x
   where x.id = s.id and x.rn > 10;
  $$
);

-- 合言葉・復帰トークンの失敗記録（判定に使うのは直近 10 分だけなので 1 日で消してよい）
select cron.unschedule('cleanup-access-attempts')
 where exists (select 1 from cron.job where jobname = 'cleanup-access-attempts');

select cron.schedule(
  'cleanup-access-attempts',
  '45 4 * * *',
  $$ delete from public.access_attempts where last_failed_at < now() - interval '1 day'; $$
);

-- ブラウザ側のエラー（30 日）
select cron.unschedule('cleanup-client-errors')
 where exists (select 1 from cron.job where jobname = 'cleanup-client-errors');

select cron.schedule(
  'cleanup-client-errors',
  '47 4 * * *',
  $$ delete from public.client_errors where created_at < now() - interval '30 days'; $$
);

-- 空のまま放置されたボード（週 1、日曜 5:03）
-- 中身がひとつも無く、作ってから 30 日経ち、30 日以上なにも起きていないものだけ。
-- rooms を消せば参加者・秘密・purge_queue の予約まで連鎖する。
select cron.unschedule('cleanup-empty-rooms')
 where exists (select 1 from cron.job where jobname = 'cleanup-empty-rooms');

select cron.schedule(
  'cleanup-empty-rooms',
  '3 5 * * 0',
  $$
  delete from public.rooms r
   where r.created_at < now() - interval '30 days'
     and coalesce(
           (select max(a.created_at) from public.activities a where a.room_id = r.id),
           r.created_at
         ) < now() - interval '30 days'
     and not exists (select 1 from public.notes       x where x.room_id = r.id)
     and not exists (select 1 from public.strokes     x where x.room_id = r.id)
     and not exists (select 1 from public.events      x where x.room_id = r.id)
     and not exists (select 1 from public.todos       x where x.room_id = r.id)
     and not exists (select 1 from public.images      x where x.room_id = r.id)
     and not exists (select 1 from public.attachments x where x.room_id = r.id)
     and not exists (select 1 from public.comments    x where x.room_id = r.id)
     and not exists (select 1 from public.polls       x where x.room_id = r.id)
     and not exists (select 1 from public.frames      x where x.room_id = r.id)
     and not exists (select 1 from public.connectors  x where x.room_id = r.id);
  $$
);

-- 使われなくなった匿名ユーザー（週 1、日曜 5:13）
-- 匿名サインインはページを開くたびに ID を作るので、放っておくと auth.users が増え続ける。
-- 30 日以上サインインが無く、どのボードにも参加しておらず、ボードも持っていない人だけ消す。
-- 続けて、その人あての通知・プッシュ購読・エラー記録も片付ける。
select cron.unschedule('cleanup-anon-users')
 where exists (select 1 from cron.job where jobname = 'cleanup-anon-users');

select cron.schedule(
  'cleanup-anon-users',
  '13 5 * * 0',
  $$
  delete from auth.users u
   where u.is_anonymous
     and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '30 days'
     and not exists (select 1 from public.room_members m where m.user_id = u.id)
     and not exists (select 1 from public.rooms r where r.owner_id = u.id);

  delete from public.push_subscriptions p
   where not exists (select 1 from auth.users u where u.id = p.user_id);
  delete from public.notifications n
   where not exists (select 1 from auth.users u where u.id = n.user_id);
  delete from public.client_errors c
   where not exists (select 1 from auth.users u where u.id = c.user_id);
  $$
);

-- 設定内容の確認
-- select jobname, schedule, active from cron.job order by jobname;
-- 直近の実行結果
-- select jobname, status, return_message, start_time
--   from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--  order by start_time desc limit 20;
