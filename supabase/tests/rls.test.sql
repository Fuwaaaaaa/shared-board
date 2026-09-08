-- =============================================================================
--  みんなのボード — RLS / トリガー / RPC のテスト
-- -----------------------------------------------------------------------------
--  「画面のボタンを消しているだけ」ではないことを、DB 側で確かめます。
--  許可されるはずのことと、拒否されるはずのことの両方を見ます。
--
--  実行のしかた（どちらでも同じ結果になります）
--
--    A) Supabase CLI
--         supabase test db
--
--    B) psql（schema.sql を流した DB に対して）
--         psql -U postgres -f supabase/tests/rls.test.sql
--
--  すべてトランザクションの中で行い、最後に巻き戻すのでデータは残りません。
-- =============================================================================

begin;

create extension if not exists pgtap;

select plan(252);


-- =============================================================================
--  下ごしらえ
-- =============================================================================

-- 「その人としてアクセスする」ためのヘルパー。
-- Supabase の auth.uid() は JWT の sub を見るので、そこだけ差し替える。
create or replace function tests_act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- セッションが無い人（anon）としてアクセスする。auth.uid() は null になる。
create or replace function tests_act_as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end;
$$;

-- 書き込みが「何行に効いたか」を返す。
-- RLS の USING で弾かれたときは 0 行（例外にならない）、
-- WITH CHECK で弾かれたときは例外になるので -1 を返して区別する。
create or replace function tests_rowcount(p_sql text) returns int
language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception
  when insufficient_privilege then return -1;
  when others then return -2;               -- 想定外の失敗。テストで落とす
end;
$$;

-- 実行して、例外になればその文言を返す。ならなければ ''。
-- 「どういう文言で断られるか」まで確かめたいときに使う。
create or replace function tests_error(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return '';
exception
  when others then return sqlerrm;
end;
$$;

--  人
--    11111111… ゆうき   … 作成者（オーナー）
--    22222222… けいこ   … 編集できる参加者
--    33333333… みなみ   … 閲覧のみの参加者
--    44444444… たかし   … まだ参加していない人
--
--  ボード
--    aaaaaaaa… 開いているボード（リンク公開）
--    bbbbbbbb… 終了したボード  （リンク公開・archived）
--    cccccccc… 承認制のボード
--    dddddddd… 締め出し・期限・リンク作り直しの実験用（リンク公開）
--    eeeeeeee… 合言葉つきのボード（オーナーだけ。合言葉は「ひみつのことば」）
--    ffffffff… リンク公開だが、まだオーナーしかいないボード

insert into public.rooms (id, slug, name, visibility, owner_id, owner_name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'openlink', '開いているボード', 'public',  '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'closedbd', '終了したボード',   'public',  '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'approval', '承認制のボード',   'private', '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'joinroom', '実験用のボード',   'public',  '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'pinboard', '合言葉つきのボード', 'private', '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'linkonly', 'まだ誰もいないボード', 'public', '11111111-1111-1111-1111-111111111111', 'ゆうき');

-- 最初の 4 つには 3 人とも入れておく
insert into public.room_members (room_id, user_id, display_name, role, status, can_edit)
select r.id, m.user_id, m.display_name, m.role, 'approved', m.can_edit
  from public.rooms r
 cross join (values
   ('11111111-1111-1111-1111-111111111111'::uuid, 'ゆうき', 'owner',  true),
   ('22222222-2222-2222-2222-222222222222'::uuid, 'けいこ', 'member', true),
   ('33333333-3333-3333-3333-333333333333'::uuid, 'みなみ', 'member', false)
 ) as m(user_id, display_name, role, can_edit)
 where r.id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                'cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd');

-- 合言葉つき・リンク公開の 2 つはオーナーだけ
insert into public.room_members (room_id, user_id, display_name, role, status, can_edit) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'ゆうき', 'owner', 'approved', true),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '11111111-1111-1111-1111-111111111111', 'ゆうき', 'owner', 'approved', true);

-- 終了するボードの中身は、終了する前に入れておく
insert into public.notes (id, room_id, text, author_id, author_name) values
  ('11110000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '終了前に書いた付箋', '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('11110000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '開いているボードの付箋', '11111111-1111-1111-1111-111111111111', 'ゆうき'),
  ('11110000-0000-0000-0000-000000000003', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'リンク公開の付箋', '11111111-1111-1111-1111-111111111111', 'ゆうき');

insert into public.events (id, room_id, title, start_at, author_id, author_name) values
  ('22220000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '終了前に入れた予定', now(), '11111111-1111-1111-1111-111111111111', 'ゆうき');

-- ここで終了させる
update public.rooms set archived = true
 where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

-- 合言葉はオーナーとして RPC から設定する（平文では保存されない）
select tests_act_as('11111111-1111-1111-1111-111111111111');
select public.set_join_pin('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ひみつのことば');

-- 復帰トークンはオーナーしか読めないので、テストから使えるよう控えておく
create temp table tests_secrets as
  select room_id, recovery_token from public.room_secrets;
grant select on tests_secrets to authenticated;

-- ここから先は、ふつうの利用者（authenticated）として動く。
-- postgres のままだと superuser なので RLS を素通りしてしまう。
set local role authenticated;


-- =============================================================================
--  1. 終了したボードは「読めるが書けない」
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（編集できる人）

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'あとから足す', '22222222-2222-2222-2222-222222222222', 'けいこ')$$),
  -1, '終了したボードには付箋を追加できない');

select is(
  tests_rowcount($$update public.events set title = '書き換えた'
                    where id = '22220000-0000-0000-0000-000000000001'$$),
  0, '終了したボードの予定は書き換えられない');

select is(
  tests_rowcount($$update public.notes set deleted_at = now()
                    where id = '11110000-0000-0000-0000-000000000001'$$),
  0, '終了したボードの付箋はゴミ箱にも入れられない');

select is(
  tests_rowcount($$delete from public.notes
                    where id = '11110000-0000-0000-0000-000000000001'$$),
  0, '終了したボードの付箋は消せない');

select is(
  tests_rowcount($$insert into public.strokes (room_id, points, author_id)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '[[1,2]]'::jsonb, '22222222-2222-2222-2222-222222222222')$$),
  -1, '終了したボードには手描きも足せない');

select is(
  tests_rowcount($$insert into public.comments (room_id, target_type, body, author_id, author_name)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'board', 'まだ書ける？', '22222222-2222-2222-2222-222222222222', 'けいこ')$$),
  -1, '終了したボードにはコメントも書けない');

select is(
  tests_rowcount($$insert into public.note_votes (room_id, note_id, user_id, voter_name)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11110000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'けいこ')$$),
  -1, '終了したボードには投票できない');

select is(
  tests_rowcount($$insert into public.note_reactions (room_id, note_id, user_id, emoji)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11110000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', '👍')$$),
  -1, '終了したボードにはリアクションも付けられない');

select is(
  (select count(*)::int from public.notes
    where room_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1, '終了したボードの中身は、そのまま読める');

select is(
  (select can_edit from public.get_room_preview('closedbd')),
  false, '終了したボードでは can_edit が false になる（画面が閲覧モードに落ちる）');

select is(
  (select archived from public.get_room_preview('closedbd')),
  true, 'get_room_preview が終了状態を返す');


-- =============================================================================
--  2. 終了・再開はオーナーだけ
-- =============================================================================

select is(
  tests_rowcount($$update public.rooms set archived = false
                    where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$),
  0, '参加者はボードを再開できない');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$update public.rooms set archived = false
                    where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$),
  1, 'オーナーはボードを再開できる');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '再開したので書ける', '22222222-2222-2222-2222-222222222222', 'けいこ')$$),
  1, '再開すると、また書けるようになる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      and target_type = 'access' and action = 'board_reopened'),
  1, '再開したことが履歴に残る');


-- =============================================================================
--  3. 「閲覧のみ」は書けない。ただしコメントと投票はできる
-- =============================================================================

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（閲覧のみ）

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '閲覧のみでも書ける？', '33333333-3333-3333-3333-333333333333', 'みなみ')$$),
  -1, '閲覧のみの人は付箋を追加できない');

select is(
  tests_rowcount($$update public.notes set text = '書き換え'
                    where id = '11110000-0000-0000-0000-000000000002'$$),
  0, '閲覧のみの人は付箋を書き換えられない');

select is(
  tests_rowcount($$insert into public.comments (room_id, target_type, body, author_id, author_name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'board', '意見はあります', '33333333-3333-3333-3333-333333333333', 'みなみ')$$),
  1, '閲覧のみの人でもコメントはできる');

select is(
  tests_rowcount($$insert into public.note_votes (room_id, note_id, user_id, voter_name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11110000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'みなみ')$$),
  1, '閲覧のみの人でも投票はできる');


-- =============================================================================
--  4. 変更履歴は、外から書き込めない
-- =============================================================================

select ok(
  not has_function_privilege('anon', 'public.log_access(uuid,text,text,text)', 'EXECUTE'),
  'anon は log_access を実行できない');

select ok(
  not has_function_privilege('authenticated', 'public.log_access(uuid,text,text,text)', 'EXECUTE'),
  'authenticated は log_access を実行できない');

select ok(
  not (select coalesce(bool_or(a.grantee = 0), false)
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(p.proacl) a
        where n.nspname = 'public' and p.proname = 'log_access'),
  'PUBLIC にも log_access の実行権限が残っていない');

select throws_ok(
  $$select public.log_access('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'board_closed', 'にせの記録')$$,
  '42501',
  null,
  '参加者が log_access を直接呼ぶと拒否される');

select is(
  tests_rowcount($$insert into public.activities (room_id, actor_name, action, target_type, target_label)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ゆうき', 'board_closed', 'access', 'にせの記録')$$),
  -1, '変更履歴のテーブルへ直接 INSERT もできない');


-- =============================================================================
--  5. 権限の変更が履歴に残る
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$update public.room_members set can_edit = false
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '22222222-2222-2222-2222-222222222222'$$),
  1, 'オーナーは参加者を閲覧のみにできる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and target_type = 'access' and action = 'member_view_only'
      and target_label = 'けいこ'),
  1, '閲覧のみにしたことが、相手の名前つきで履歴に残る');

select is(
  (select actor_name from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and action = 'member_view_only' limit 1),
  'ゆうき', '履歴には「変えた人」が記録される（変えられた人ではない）');

-- 表示名を変えただけでは履歴に残らない（流れが埋まらないように）
select tests_act_as('33333333-3333-3333-3333-333333333333');
select is(
  tests_rowcount($$update public.room_members set display_name = 'みなみ（スマホ）'
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  1, '自分の表示名は変えられる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and target_type = 'access' and target_label like 'みなみ%'
      -- 下ごしらえで参加者として入れたときの member_joined は数えない
      and action <> 'member_joined'),
  0, '表示名を変えただけでは履歴に残らない');


-- =============================================================================
--  6. 全員を締め出す — まとめて 1 行だけ残す
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select lives_ok(
  $$select public.revoke_all_members('dddddddd-dddd-dddd-dddd-dddddddddddd', true)$$,
  'オーナーは全員を締め出せる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
      and target_type = 'access' and action = 'members_revoked_all'),
  1, '締め出しは「まとめて 1 行」だけ残る');

select is(
  (select count(*)::int from public.activities
    where room_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
      and target_type = 'access'
      and action in ('member_removed', 'member_rejected', 'access_mode', 'link_rotated')),
  0, '締め出しの途中経過（1 人ずつ・入り方・リンク）は履歴に出さない');

select is(
  (select visibility from public.rooms where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'private', '締め出すと、リンク公開ではなくなる');

select is(
  (select count(*)::int from public.room_members
    where room_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' and status = 'approved'),
  1, '締め出したあと、残っているのはオーナーだけ');

-- 抑止フラグを持ち越さないこと。
-- set_config の第 3 引数が true なので、このトランザクションを抜ければ消える。
-- 接続が使い回されても、次の処理の記録が黙って落ちることはない。
select is(
  coalesce(pg_catalog.current_setting('app.skip_access_log', true), ''),
  '', '締め出しが終わったあと、抑止フラグは残っていない');

-- 同じ接続・同じボードで続けて操作しても、ちゃんと記録される
select is(
  tests_rowcount($$update public.rooms set join_closed = true
                    where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'$$),
  1, '締め出したあとも、同じボードの設定を変えられる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
      and target_type = 'access' and action = 'join_settings'),
  1, '締め出した直後でも、同じボード・同じ接続の次の操作は履歴に残る');


-- =============================================================================
--  7. 履歴の抑止フラグは、他のボードには効かない
-- =============================================================================

-- 利用者が自分でフラグを立てられたとしても、別のボードの記録は落ちない。
-- （そもそも set_config は PostgREST が公開するスキーマに無いので外からは触れない）
select set_config('app.skip_access_log', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true);

select is(
  tests_rowcount($$update public.room_members set can_edit = true
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '22222222-2222-2222-2222-222222222222'$$),
  1, '別のボードで権限を戻せる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and target_type = 'access' and action = 'member_can_edit'),
  1, '別のボードに立てたフラグでは、こちらの履歴は消えない');

select set_config('app.skip_access_log', '', true);


-- =============================================================================
--  8. 参加のしかた — 期限・リンクの作り直し・承認制
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');

-- 参加期限を過去にする
select is(
  tests_rowcount($$update public.rooms set join_expires_at = now() - interval '1 day'
                    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$),
  1, 'オーナーは参加期限を設定できる');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし（未参加）

select throws_ok(
  $$select public.request_access('openlink', 'たかし')$$,
  'P0001',
  '新しく参加できる期限を過ぎています',
  '期限を過ぎると、新しくは参加できない');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（参加済み）

select is(
  public.request_access('openlink', 'けいこ'),
  'approved',
  '期限を過ぎても、すでに参加している人はそのまま使える');

-- リンクを作り直すと、古い URL では入れない
select tests_act_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
  $$select public.rotate_room_slug('cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  'オーナーは共有リンクを作り直せる');

select tests_act_as('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$select public.request_access('approval', 'たかし')$$,
  'P0001',
  'ルームが見つかりません',
  '作り直したあと、古いリンクからは参加できない');

-- 履歴を数えるのはオーナーとして。承認制のボードの activities は
-- 参加していない人からは読めない（それ自体は 1 つ上のテストで確かめている）
select tests_act_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from public.activities
    where room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
      and target_type = 'access' and action = 'link_rotated'),
  1, 'リンクを作り直したことが履歴に残る');

select tests_act_as('44444444-4444-4444-4444-444444444444');

-- 承認制のボードの中身は、承認されるまで見えない
select is(
  (select count(*)::int from public.notes
    where room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  0, '承認制のボードの中身は、参加していない人には見えない');

select is(
  tests_rowcount($$update public.rooms set name = '乗っ取り'
                    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$),
  0, '参加していない人はボードの設定を変えられない');


-- =============================================================================
--  9. 合言葉まわりの履歴
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');

select lives_ok(
  $$select public.set_join_pin('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ひみつのことば')$$,
  'オーナーは合言葉を設定できる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and target_type = 'access' and action = 'pin_set'),
  1, '合言葉を設定したことが履歴に残る（合言葉そのものは残らない）');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and target_label like '%ひみつのことば%'),
  0, '合言葉そのものは履歴に出ない');

select tests_act_as('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$select public.set_join_pin('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'かってに')$$,
  'P0001',
  'オーナーだけが変更できます',
  '参加者は合言葉を変えられない');

select ok(
  (select count(*) = 0 from public.room_secrets
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '参加者からは合言葉と復帰トークンが読めない');


-- =============================================================================
--  10. 終了したボードには、オーナー自身も書けない
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$update public.rooms set archived = true
                    where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$),
  1, 'オーナーはボードを終了できる');

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'オーナーなら？', '11111111-1111-1111-1111-111111111111', 'ゆうき')$$),
  -1, '終了したボードには、オーナー自身も付箋を追加できない');

select is(
  tests_rowcount($$update public.notes set text = 'オーナーが書き換え'
                    where id = '11110000-0000-0000-0000-000000000001'$$),
  0, '終了したボードの付箋は、オーナーでも書き換えられない');

select is(
  tests_rowcount($$insert into public.comments (room_id, target_type, body, author_id, author_name)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'board', 'ひとこと', '11111111-1111-1111-1111-111111111111', 'ゆうき')$$),
  -1, '終了したボードには、オーナーでもコメントできない');


-- =============================================================================
--  11. リンク公開のボードでも、参加登録するまでは読めない
-- =============================================================================

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし（未参加）

select is(
  (select count(*)::int from public.rooms
    where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  0, 'リンク公開のボードでも、登録前は rooms の行が見えない');

select is(
  (select count(*)::int from public.notes
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  0, 'リンク公開のボードでも、登録前は付箋が見えない');

select is(
  (select count(*)::int from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  0, 'リンク公開のボードでも、登録前は参加者一覧が見えない');

select is(
  (select name from public.get_room_preview('linkonly')),
  'まだ誰もいないボード', '名前だけは get_room_preview で分かる（入る前の画面に要る）');

-- 直接 INSERT では参加者になれない（受付停止・期限・上限・合言葉をすり抜けてしまうため）
select is(
  tests_rowcount($$insert into public.room_members (room_id, user_id, display_name, role, status)
                   values ('ffffffff-ffff-ffff-ffff-ffffffffffff', '44444444-4444-4444-4444-444444444444', 'たかし', 'member', 'approved')$$),
  -1, '参加者として自分を直接 INSERT できない（approved）');

select is(
  tests_rowcount($$insert into public.room_members (room_id, user_id, display_name, role, status)
                   values ('ffffffff-ffff-ffff-ffff-ffffffffffff', '44444444-4444-4444-4444-444444444444', 'たかし', 'member', 'pending')$$),
  -1, '申請の行も直接 INSERT できない（pending）');

select is(
  tests_rowcount($$insert into public.room_members (room_id, user_id, display_name, role, status)
                   values ('ffffffff-ffff-ffff-ffff-ffffffffffff', '44444444-4444-4444-4444-444444444444', 'たかし', 'owner', 'approved')$$),
  -1, '自分のものでないボードにオーナーとして INSERT できない');

-- request_access を通れば、その場で参加者になって読める
select is(
  public.request_access('linkonly', 'たかし'),
  'approved', 'リンク公開のボードは request_access でその場で承認される');

select is(
  (select count(*)::int from public.notes
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  1, '登録が済むと付箋が読める');

select is(
  (select count(*)::int from public.rooms
    where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  1, '登録が済むと rooms の行も見える');

-- 承認を待たずに入った人は、この INSERT でしか記録が残らない
-- （承認された人なら status の変化を member_approved が拾う）
select is(
  (select count(*)::int from public.activities
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and target_type = 'access' and action = 'member_joined'),
  1, '承認を待たずに入った人も、更新（履歴）に残る');

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'たかしの付箋', '44444444-4444-4444-4444-444444444444', 'たかし')$$),
  1, '登録が済むと書ける（リンク公開の参加者は編集できる）');

-- 取り消された人は、リンク公開でも入り直せない
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$update public.room_members set status = 'rejected', decided_at = now()
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '44444444-4444-4444-4444-444444444444'$$),
  1, 'オーナーは参加者のアクセスを取り消せる');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select is(
  (select count(*)::int from public.notes
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  0, '取り消されると、リンク公開でも読めなくなる');

-- 行ごと消して、無かったことにもできない。
-- 消せてしまうと「まだ来ていない人」に戻れるので、リンク公開のボードでは
-- request_access がその場で承認してしまい、取り消しが帳消しになる。
select is(
  tests_rowcount($$delete from public.room_members
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '44444444-4444-4444-4444-444444444444'$$),
  0, '取り消された人は、自分の行を消して取り消しを帳消しにできない');

select is(
  (select status from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '44444444-4444-4444-4444-444444444444'),
  'rejected', '行は残るので、取り消した記録も残る');

-- 申し込み直す道は request_access だけ。
-- 直接 UPDATE で承認待ちに並べると、受付停止・参加期限・人数上限・合言葉の
-- 判定をすべてすり抜けられる（room_members への直接 INSERT を禁じているのと同じ理由）。
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$update public.rooms set join_closed = true
                    where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'$$),
  1, 'リンク公開のボードでも、受付は止められる');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select throws_ok(
  $$select public.request_access('linkonly', 'たかし')$$,
  'P0001',
  '参加の受付を止めています',
  '受付を止めていると、取り消された人も申し込み直せない');

select is(
  tests_rowcount($$update public.room_members set status = 'pending'
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '44444444-4444-4444-4444-444444444444'$$),
  1, '自分の行を UPDATE すること自体は通る（表示名を変えるため）');

select is(
  (select status from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '44444444-4444-4444-4444-444444444444'),
  'rejected', '直接 UPDATE では承認待ちに並べない（受付停止をすり抜けられない）');

select is(
  tests_rowcount($$update public.room_members set status = 'pending'
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '11111111-1111-1111-1111-111111111111'$$),
  0, '他人の行は、そもそも UPDATE の対象にならない');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$update public.rooms set join_closed = false
                    where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'$$),
  1, 'オーナーは受付を再開できる');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select is(
  public.request_access('linkonly', 'たかし'),
  'pending', '取り消された人が入り直そうとすると、リンク公開でも承認待ちになる');

select is(
  (select status from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '44444444-4444-4444-4444-444444444444'),
  'pending', '戻り値だけでなく、名簿の行も承認待ちに変わっている');

select ok(
  (select decided_at is null from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '44444444-4444-4444-4444-444444444444'),
  '申し込み直すと、取り消したときの日時は消える');

select is(
  coalesce(pg_catalog.current_setting('app.reapply_member', true), ''),
  '', '申し込み直しの目印は、使ったあとに残っていない');

select is(
  (select count(*)::int from public.notes
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  0, '承認待ちのあいだは、リンク公開でも中身は読めない');

select is(
  tests_rowcount($$update public.room_members set status = 'approved'
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '44444444-4444-4444-4444-444444444444'$$),
  1, '自分を承認する UPDATE も、文としては通る');

select is(
  (select status from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '44444444-4444-4444-4444-444444444444'),
  'pending', '承認待ちの人が、自分で自分を承認することはできない');

select is(
  tests_rowcount($$delete from public.room_members
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '44444444-4444-4444-4444-444444444444'$$),
  0, '承認待ちの人も、自分の行を消して申し込みを無かったことにできない');

-- 申し込み直したことは、オーナーに届く。
-- 参加者パネルを開いていないと赤バッジには気づけないので、新しい申し込みと同じ扱いにする。
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  (select count(*)::int from public.notifications
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '11111111-1111-1111-1111-111111111111'
      and kind = 'join_request'),
  1, '申し込み直したことは、作った人に知らせが飛ぶ');

select is(
  (select count(*)::int from public.activities
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and target_type = 'access' and action = 'member_joined'),
  1, '申し込み直しただけでは、参加した記録は増えない（増えるのは知らせだけ）');


-- =============================================================================
--  12. 行の持ち主とボードは動かせない
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（aaaa と cccc の両方に参加）

select is(
  tests_rowcount($$update public.room_members set room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '22222222-2222-2222-2222-222222222222'$$),
  -1, '自分の参加行の room_id は変えられない');

select is(
  tests_rowcount($$update public.room_members set user_id = '44444444-4444-4444-4444-444444444444'
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '22222222-2222-2222-2222-222222222222'$$),
  -1, '自分の参加行の user_id は変えられない');

-- 付箋は「両方のボードを編集できる人」でも、別のボードへは移せない
-- （RLS の USING / WITH CHECK はどちらのボードも通す。止めているのはトリガー）
select is(
  tests_rowcount($$update public.notes set room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
                    where id = '11110000-0000-0000-0000-000000000002'$$),
  -1, '付箋の room_id は変えられない');

select is(
  tests_rowcount($$update public.notes set author_id = '22222222-2222-2222-2222-222222222222'
                    where id = '11110000-0000-0000-0000-000000000002'$$),
  -1, '付箋の author_id は変えられない（他人の付箋を自分のものにできない）');

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'なりすまし', '11111111-1111-1111-1111-111111111111', 'ゆうき')$$),
  -1, '他人の author_id で付箋を作れない');

select is(
  tests_rowcount($$update public.notes set text = 'ふつうの書き換え'
                    where id = '11110000-0000-0000-0000-000000000002'$$),
  1, '中身の書き換えはこれまでどおりできる');

-- 閲覧のみの人が、自分で編集権限を付けることはできない
select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（閲覧のみ）

select is(
  tests_rowcount($$update public.room_members set can_edit = true
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  1, '閲覧のみの人が自分の行を UPDATE すること自体は通る（表示名の変更に使う）');

select is(
  (select can_edit from public.room_members
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id = '33333333-3333-3333-3333-333333333333'),
  false, 'それでも can_edit は変わらない（トリガーが元に戻す）');


-- =============================================================================
--  13. 通知の宛先は、そのボードの関係者だけ
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  tests_rowcount($$insert into public.notifications (room_id, user_id, kind, body)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'mention', '無関係な人あて')$$),
  -1, 'ボードと無関係な人には通知を送れない');

select is(
  tests_rowcount($$insert into public.notifications (room_id, user_id, kind, body)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'mention', '同じボードの人あて')$$),
  1, '同じボードの参加者には送れる');

select is(
  (select actor_name from public.notifications
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id = '33333333-3333-3333-3333-333333333333' limit 1),
  null, '送った側からは通知の行が読めない（宛先本人だけ）');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（宛先）

select is(
  (select actor_name from public.notifications
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id = '33333333-3333-3333-3333-333333333333' limit 1),
  'けいこ', '差出人の名前は送った本人の表示名で上書きされる');


-- =============================================================================
--  14. やることの担当者は、そのボードの関係者だけ
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  tests_rowcount($$insert into public.todos (id, room_id, title, author_id, author_name, assignee_id, assignee_name)
                   values ('33330000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '買い出し',
                           '22222222-2222-2222-2222-222222222222', 'けいこ',
                           '44444444-4444-4444-4444-444444444444', 'たかし')$$),
  1, 'INSERT 自体は通る（複製・復元で行を丸ごと入れ直せるように）');

select is(
  (select assignee_id is null and assignee_name = '' from public.todos
    where id = '33330000-0000-0000-0000-000000000001'),
  true, 'INSERT で指定した無関係な担当者は外される');

select is(
  tests_error($$update public.todos set assignee_id = '44444444-4444-4444-4444-444444444444'
                 where id = '33330000-0000-0000-0000-000000000001'$$),
  '担当者はこのボードの参加者から選んでください',
  'UPDATE で無関係な人を担当にすると、その文言で断られる');

select is(
  tests_rowcount($$update public.todos set assignee_id = '33333333-3333-3333-3333-333333333333'
                    where id = '33330000-0000-0000-0000-000000000001'$$),
  1, '同じボードの参加者なら担当にできる');

select is(
  tests_rowcount($$update public.todos set assignee_id = '11111111-1111-1111-1111-111111111111'
                    where id = '33330000-0000-0000-0000-000000000001'$$),
  1, 'オーナーも担当にできる');


-- =============================================================================
--  15. 合言葉の総当たりは止まる
-- =============================================================================

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select is(
  public.request_access('pinboard', 'たかし', '', 'ちがう'),
  'pin_mismatch', '合言葉が違うと pin_mismatch が返る（例外にしないのは失敗を数えるため）');

select public.request_access('pinboard', 'たかし', '', 'ちがう');   -- 2 回目
select public.request_access('pinboard', 'たかし', '', 'ちがう');   -- 3 回目
select public.request_access('pinboard', 'たかし', '', 'ちがう');   -- 4 回目

select is(
  public.request_access('pinboard', 'たかし', '', 'ちがう'),
  'pin_mismatch', '5 回目までは pin_mismatch');

select throws_ok(
  $$select public.request_access('pinboard', 'たかし', '', 'ひみつのことば')$$,
  'P0001',
  '間違いが続いたため、10 分ほど待ってからやり直してください',
  '6 回目は合言葉が合っていても止められる');

select is(
  (select count(*)::int from public.notes
    where room_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  0, '止められた人は中身を読めないまま');

-- 失敗の記録が残っていること（台帳はふつうの利用者からは読めないので postgres で数える）
reset role;
select is(
  (select failed_count from public.access_attempts
    where room_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
      and user_id = '44444444-4444-4444-4444-444444444444' and kind = 'pin'),
  5, '失敗が 5 回ぶん記録されている（例外で巻き戻っていない）');
set local role authenticated;

-- 別の人は、合言葉が合えば承認なしで入れる
select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  public.request_access('pinboard', 'けいこ', '', 'ひみつのことば'),
  'approved', '合言葉が合えば、承認を待たずに参加できる');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ

select is(
  public.request_access('pinboard', 'みなみ', '', '  ひみつのことば '),
  'approved', '合言葉の前後の空白は無視される');

-- 成功したので、けいこの失敗記録は残っていない
reset role;
select is(
  (select count(*)::int from public.access_attempts
    where room_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
      and user_id = '22222222-2222-2222-2222-222222222222'),
  0, '成功すると失敗の記録は消える');
set local role authenticated;


-- =============================================================================
--  16. オーナー復帰リンク
-- =============================================================================

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし（別ブラウザのつもり）

select is(
  public.claim_owner('linkonly', 'まちがったトークン', 'たかし'),
  false, 'トークンが違えば復帰できない');

select is(
  public.claim_owner('linkonly', (select recovery_token from tests_secrets
                                   where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 'たかし'),
  true, 'トークンが合えば復帰できる');

select is(
  (select is_owner from public.get_room_preview('linkonly')),
  true, '復帰した人がオーナーになっている');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（元オーナー）

select is(
  (select is_owner from public.get_room_preview('linkonly')),
  false, '元のオーナーはオーナーではなくなる');

select is(
  (select role from public.room_members
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      and user_id = '11111111-1111-1111-1111-111111111111'),
  'member', '元のオーナーは参加者として残る');


-- =============================================================================
--  17. 人数の上限・受付停止の文言
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（pinboard のオーナー）

-- pinboard はいま ゆうき・けいこ・みなみ の 3 人
select is(
  tests_rowcount($$update public.rooms set max_members = 3
                    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$$),
  1, 'オーナーは人数の上限を決められる');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select throws_ok(
  $$select public.request_access('pinboard', 'たかし', '', 'ひみつのことば')$$,
  'P0001',
  '参加できる人数の上限に達しています',
  '上限に達していると、合言葉より先にその文言で断られる');

select tests_act_as('11111111-1111-1111-1111-111111111111');

select is(
  tests_rowcount($$update public.rooms set max_members = null, join_closed = true
                    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$$),
  1, 'オーナーは受付を止められる');

select tests_act_as('44444444-4444-4444-4444-444444444444');

select throws_ok(
  $$select public.request_access('pinboard', 'たかし', '', 'ひみつのことば')$$,
  'P0001',
  '参加の受付を止めています',
  '受付を止めていると、その文言で断られる');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（参加済み）

select is(
  public.request_access('pinboard', 'けいこ', '', ''),
  'approved', '受付を止めても、すでに参加している人は合言葉なしで入り直せる');


-- =============================================================================
--  18. 文字数・件数の上限
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select ok(
  tests_error($$insert into public.notes (room_id, text, author_id, author_name)
                 values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', repeat('あ', 5001), '22222222-2222-2222-2222-222222222222', 'けいこ')$$)
  like '%5000%',
  '5001 文字の付箋は「5000 文字まで」と断られる');

select is(
  tests_rowcount($$insert into public.notes (room_id, text, author_id, author_name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', repeat('あ', 5000), '22222222-2222-2222-2222-222222222222', 'けいこ')$$),
  1, '5000 文字ちょうどなら入る');

select ok(
  tests_error($$insert into public.notes (room_id, text, tags, author_id, author_name)
                 values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'タグだらけ',
                         (select array_agg('t' || g) from generate_series(1, 21) g),
                         '22222222-2222-2222-2222-222222222222', 'けいこ')$$)
  like '%notes_tags_count%',
  'タグは 20 個まで');

select ok(
  tests_error($$update public.room_members set display_name = repeat('な', 31)
                 where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                   and user_id = '22222222-2222-2222-2222-222222222222'$$)
  like '%30%',
  '表示名は 30 文字まで（UPDATE でも効く）');

-- ボードあたりの件数
select is(
  tests_rowcount($$insert into public.calendar_feeds (room_id, name, url, author_id)
                   select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'feed ' || g, 'https://example.com/' || g || '.ics',
                          '22222222-2222-2222-2222-222222222222'
                     from generate_series(1, 20) g$$),
  20, '外部カレンダーは 20 件まで入る');

select is(
  tests_error($$insert into public.calendar_feeds (room_id, name, url, author_id)
                 values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '21 件目', 'https://example.com/21.ics',
                         '22222222-2222-2222-2222-222222222222')$$),
  '外部カレンダー はボードあたり 20 件までです',
  '21 件目はその文言で断られる');

-- 1 人が作れるボードの数（たかしは 16. で linkonly のオーナーになっているので、あと 49 個）
select tests_act_as('44444444-4444-4444-4444-444444444444');

select is(
  tests_rowcount($$insert into public.rooms (slug, name, owner_id, owner_name)
                   select 'limit' || g, 'ボード ' || g, '44444444-4444-4444-4444-444444444444', 'たかし'
                     from generate_series(1, 49) g$$),
  49, 'ボードはあわせて 50 個まで作れる');

select is(
  tests_error($$insert into public.rooms (slug, name, owner_id, owner_name)
                 values ('limit51', '51 個目', '44444444-4444-4444-4444-444444444444', 'たかし')$$),
  'ボードは 1 人 50 個までです',
  '51 個目はその文言で断られる');

-- 上限は「作る」だけでなく「受け取る」にも効く。
-- オーナー復帰は rooms.owner_id を付け替えるので、INSERT だけを見ていると
-- ここから何個でも増やせてしまう（作れないぶんを受け取りで回避できる）。
reset role;
insert into public.rooms (id, slug, name, owner_id, owner_name) values
  ('cafe0000-0000-0000-0000-000000000001', 'capboard', '上限の実験用', '11111111-1111-1111-1111-111111111111', 'ゆうき');
insert into tests_secrets
  select room_id, recovery_token from public.room_secrets
   where room_id = 'cafe0000-0000-0000-0000-000000000001';
set local role authenticated;

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし（ここで 50 個）

select throws_ok(
  $$select public.claim_owner('capboard',
      (select recovery_token from tests_secrets
        where room_id = 'cafe0000-0000-0000-0000-000000000001'), 'たかし')$$,
  '23514',
  'ボードは 1 人 50 個までです',
  '上限に達していると、オーナー復帰でもボードを受け取れない');

-- 付け替わっていないことは postgres で確かめる（たかしはこのボードを読めない）
reset role;
select is(
  (select owner_id from public.rooms where id = 'cafe0000-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid,
  '断られたので、作った人のままになっている');
set local role authenticated;


-- =============================================================================
--  19. セッションが無い人（anon）には何も見えない・呼べない
-- =============================================================================

set local role anon;
select tests_act_as_anon();

select is((select count(*)::int from public.rooms),         0, 'anon には rooms が 1 件も見えない');
select is((select count(*)::int from public.notes),         0, 'anon には notes が 1 件も見えない');
select is((select count(*)::int from public.room_members),  0, 'anon には room_members が 1 件も見えない');
select is((select count(*)::int from public.notifications), 0, 'anon には notifications が 1 件も見えない');
select is((select count(*)::int from public.activities),    0, 'anon には activities が 1 件も見えない');

select throws_ok(
  $$select * from public.get_room_preview('linkonly')$$,
  '42501', null,
  'anon は get_room_preview を呼べない');

select throws_ok(
  $$select public.request_access('linkonly', 'だれか')$$,
  '42501', null,
  'anon は request_access を呼べない');

select throws_ok(
  $$select public.claim_owner('linkonly', 'x')$$,
  '42501', null,
  'anon は claim_owner を呼べない');

select throws_ok(
  $$select public.rotate_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null,
  'anon はカレンダーの購読 URL を発行できない');

select throws_ok(
  $$select public.clear_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null,
  'anon はカレンダーの購読 URL を止められない');

set local role authenticated;


-- =============================================================================
--  20. Storage の実体の掃除が予約される
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$insert into public.images (id, room_id, storage_path, author_id, author_name)
                   values ('44440000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/photo.png',
                           '11111111-1111-1111-1111-111111111111', 'ゆうき')$$),
  1, '画像の行を置ける');

select is(
  tests_rowcount($$delete from public.images where id = '44440000-0000-0000-0000-000000000001'$$),
  1, '画像の行を消せる');

select is(
  tests_rowcount($$delete from public.rooms where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'$$),
  1, 'オーナーはボードを消せる');

select is(
  (select count(*)::int from public.purge_queue),
  0, '掃除の予約は利用者からは見えない');

reset role;

select is(
  (select count(*)::int from public.purge_queue
    where bucket = 'board-images' and kind = 'object'
      and path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/photo.png'),
  1, '画像の行を消すと、その実体の掃除が 1 件予約される');

select is(
  (select count(*)::int from public.purge_queue
    where kind = 'prefix' and path = 'dddddddd-dddd-dddd-dddd-dddddddddddd/'),
  2, 'ボードを消すと、両方のバケットのフォルダ掃除が予約される');

set local role authenticated;


-- =============================================================================
--  21. 合言葉は平文では残っていない
-- =============================================================================

reset role;

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'room_secrets' and column_name = 'join_pin'),
  0, '平文の join_pin 列はもう無い');

select ok(
  (select pin_hash like '$2%' from public.room_secrets
    where room_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  '合言葉は bcrypt のハッシュで保存されている');

select ok(
  (select pin_hash is null from public.room_secrets
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  '合言葉のないボードは null');

set local role authenticated;


-- =============================================================================
--  22. 試行回数の台帳は外から触れない
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');

select throws_ok(
  $$select public.check_access_attempts('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'pin')$$,
  '42501', null,
  '参加者は check_access_attempts を直接呼べない');

select throws_ok(
  $$select public.record_access_attempt('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'pin', true)$$,
  '42501', null,
  '参加者は record_access_attempt を直接呼べない（ロックを自分で解除できない）');

select ok(
  not has_function_privilege('anon', 'public.get_room_preview(text)', 'EXECUTE'),
  'anon には get_room_preview の実行権限が無い');



-- =============================================================================
--  23. 所属ルームの整合性 — 他人のボードの行を指せない
--
--      room_id と「親の id」を別々に持つ表は、両方がそろって初めて意味を持つ。
--      片方だけ自分のボードにして他方を他人のボードの id にできると、
--      自分のボードへの書き込み権限だけで他人のボードに手を出せてしまう。
--      （とくに event_overrides は、通知の送信側が event_id だけで引くため実害が出た）
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（両方のボードのオーナー）

select throws_ok(
  $$insert into public.event_overrides (room_id, event_id, occurrence_date, canceled, author_id, author_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22220000-0000-0000-0000-000000000001',
            current_date, true, '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '23503', null,
  '他のボードの予定を指す「この回だけ」は作れない');

select throws_ok(
  $$insert into public.note_votes (room_id, note_id, user_id, voter_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11110000-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '23503', null,
  '他のボードの付箋には投票できない');

select throws_ok(
  $$insert into public.note_reactions (room_id, note_id, user_id, emoji)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11110000-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111', '+1')$$,
  '23503', null,
  '他のボードの付箋にはリアクションできない');

select throws_ok(
  $$insert into public.connectors (room_id, from_note_id, to_note_id, author_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '11110000-0000-0000-0000-000000000002', '11110000-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111')$$,
  '23503', null,
  '他のボードの付箋へは線を引けない');

insert into public.events (id, room_id, title, start_at, recurrence, author_id, author_name)
values ('22220000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '毎週の打ち合わせ', now(), 'weekly', '11111111-1111-1111-1111-111111111111', 'ゆうき');

select lives_ok(
  $$insert into public.event_overrides (room_id, event_id, occurrence_date, canceled, author_id, author_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22220000-0000-0000-0000-000000000009',
            current_date, true, '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '同じボードの予定なら「この回だけ」を作れる');


-- =============================================================================
--  24. Storage のパスは、自分のボードのフォルダの外を指せない
--
--      この値は削除トリガーがそのまま掃除の予約に積み、Edge Function が
--      service_role で消しに行く。自由にしておくと、他人のボードのファイルを
--      消させたり、逆に「まだ使われている」と誤認させて消えなくしたりできる。
-- =============================================================================

select throws_ok(
  $$insert into public.images (room_id, storage_path, author_id, author_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/yoso.png',
            '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '23514', null,
  '他のボードのフォルダを指す画像の行は作れない');

select lives_ok(
  $$insert into public.images (room_id, storage_path, author_id, author_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/jibun.png',
            '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '自分のボードのフォルダなら置ける');


-- =============================================================================
--  25. 書いた人の名前は自己申告できない
--
--      RLS が強制しているのは author_id だけなので、以前は author_name に
--      他人の名前を入れて投稿できた（画面では本人と区別が付かない）。
-- =============================================================================

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（閲覧のみ）

insert into public.comments (id, room_id, target_type, body, author_id, author_name)
values ('77770000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'board', 'オーナーのふりをした発言', '33333333-3333-3333-3333-333333333333', 'ゆうき');

-- 期待値は参加者一覧の表示名そのもの（前の節で改名しているので直書きしない）
select is(
  (select author_name from public.comments where id = '77770000-0000-0000-0000-000000000001'),
  (select display_name from public.room_members
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id = '33333333-3333-3333-3333-333333333333'),
  'コメントの名前は、書いた本人の表示名で上書きされる');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（編集できる人）

insert into public.notes (id, room_id, text, author_id, author_name)
values ('11110000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'オーナーが書いたことにした付箋', '22222222-2222-2222-2222-222222222222', 'ゆうき');

select is(
  (select author_name from public.notes where id = '11110000-0000-0000-0000-000000000009'),
  'けいこ', '付箋の名前も、書いた本人の表示名で上書きされる');

-- 更新は「上書き」ではなく「凍結」。ここを上書きにすると、他人の付箋を
-- ドラッグして動かしただけで作成者が入れ替わってしまう。
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（書いた人ではない）

update public.notes set x = 999, y = 999
 where id = '11110000-0000-0000-0000-000000000009';

select is(
  (select author_name from public.notes where id = '11110000-0000-0000-0000-000000000009'),
  'けいこ', '他人が付箋を動かしても、書いた人の名前は変わらない');

select is(
  tests_rowcount($$update public.notes set author_name = 'ゆうき'
                    where id = '11110000-0000-0000-0000-000000000009'$$),
  1, '名前を変えようとしても通るが、値は変わらない（下で確認）');

select is(
  (select author_name from public.notes where id = '11110000-0000-0000-0000-000000000009'),
  'けいこ', '更新で書いた人の名前を書き換えることはできない');

select tests_act_as('33333333-3333-3333-3333-333333333333');

insert into public.note_votes (room_id, note_id, user_id, voter_name)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11110000-0000-0000-0000-000000000009',
        '33333333-3333-3333-3333-333333333333', 'ゆうき');

select is(
  (select voter_name from public.note_votes
    where note_id = '11110000-0000-0000-0000-000000000009'
      and user_id = '33333333-3333-3333-3333-333333333333'),
  (select display_name from public.room_members
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and user_id = '33333333-3333-3333-3333-333333333333'),
  '投票した人の名前も上書きされる');


-- =============================================================================
--  26. 通知は、終了したボードには積めない / 飛び先も決まった値だけ
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');

select is(
  tests_rowcount($$insert into public.notifications (room_id, user_id, kind, body, link_tab)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                           '11111111-1111-1111-1111-111111111111', 'mention', 'よびだし', 'board')$$),
  -1, '終了したボードには通知を積めない');

select throws_ok(
  $$insert into public.notifications (room_id, user_id, kind, body, link_tab)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '11111111-1111-1111-1111-111111111111', 'mention', 'よびだし', 'よそ')$$,
  '23514', null,
  '通知の飛び先タブは決まった値しか入らない');


-- =============================================================================
--  27. 共有リンクと合言葉の形
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');

select throws_ok(
  $$update public.rooms set slug = 'abunai/slug?x=1'
     where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  '23514', null,
  '共有リンクの slug に記号は入れられない');

select is(
  tests_rowcount($$update public.rooms set slug = 'newslug01'
                    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$),
  1, '英小文字と数字なら slug を変えられる');

select throws_ok(
  $$select public.set_join_pin('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ひみ')$$,
  'P0001', '合言葉は 6 文字以上にしてください',
  '短すぎる合言葉は設定できない');


-- =============================================================================
--  28. Storage の権限 — 貼れるのは編集できる人だけ、読めるのは参加者
--
--      docs/SETUP.md の手動手順が can_access_room と書き違えていても
--      気づけるように、ここで実装のほうを確かめる。
-- =============================================================================

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（閲覧のみ）

select is(
  tests_rowcount($$insert into storage.objects (bucket_id, name)
                   values ('board-images', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/kossori.png')$$),
  -1, '閲覧のみの人は画像を置けない');

select is(
  tests_rowcount($$insert into storage.objects (bucket_id, name)
                   values ('board-files', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/kossori.pdf')$$),
  -1, '閲覧のみの人は添付ファイルも置けない');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし（参加していない人）

select is(
  tests_rowcount($$insert into storage.objects (bucket_id, name)
                   values ('board-images', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/yosomono.png')$$),
  -1, '参加していない人は画像を置けない');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（編集できる人）

select is(
  tests_rowcount($$insert into storage.objects (bucket_id, name)
                   values ('board-images', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/keiko.png')$$),
  1, '編集できる人は画像を置ける');

select tests_act_as('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*)::int from storage.objects
    where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/keiko.png'),
  1, '閲覧のみの人でも画像は見える');

select tests_act_as('44444444-4444-4444-4444-444444444444');

select is(
  (select count(*)::int from storage.objects
    where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/keiko.png'),
  0, '参加していない人には画像が見えない');


-- =============================================================================
--  29. これまで確かめていなかったポリシー
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');

insert into public.polls (id, room_id, title, author_id, author_name)
values ('88880000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '次はいつにする？', '11111111-1111-1111-1111-111111111111', 'ゆうき');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（閲覧のみ）

select is(
  tests_rowcount($$insert into public.poll_options (poll_id, room_id, start_at)
                   values ('88880000-0000-0000-0000-000000000001',
                           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now())$$),
  -1, '閲覧のみの人は候補日を足せない');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  tests_rowcount($$update public.comments set body = '書き換えた'
                    where id = '77770000-0000-0000-0000-000000000001'$$),
  0, '他人のコメントは書き換えられない');

reset role;
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, display_name)
values ('11111111-1111-1111-1111-111111111111', 'https://example.test/push/yuuki', 'p', 'a', 'ゆうき');
set local role authenticated;

select is(
  (select count(*)::int from public.push_subscriptions
    where endpoint = 'https://example.test/push/yuuki'),
  0, '他人のプッシュ購読は読めない（通知の宛先は capability そのもの）');

select tests_act_as('11111111-1111-1111-1111-111111111111');

select is(
  tests_rowcount($$delete from public.comments
                    where id = '77770000-0000-0000-0000-000000000001'$$),
  1, 'オーナーは他人のコメントを消せる');


-- =============================================================================
--  30. 在席とカーソルのチャンネルにも権限がある
--
--      presence / broadcast は postgres_changes と違って RLS の外にある。
--      realtime.messages にポリシーが無いと、id を知っている人は
--      アクセスを取り消されたあとも在席とカーソルを覗き続けられる。
--      （realtime スキーマの無い環境ではこの確認を飛ばす）
-- =============================================================================

select ok(
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'realtime' and c.relname = 'messages'
  )
  or exists (
    select 1 from pg_policies
     where schemaname = 'realtime' and tablename = 'messages'
       and policyname in ('board_presence_read', 'board_presence_write')
  ),
  '在席チャンネル（realtime.messages）にポリシーがある');

select is(
  public.realtime_room_id('presence:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'トピック名からボードの id を取り出せる');

select ok(
  public.realtime_room_id('presence:not-a-uuid') is null,
  '知らない形のトピックは null になる（can_access_room(null) は false）');


-- =============================================================================
--  31. 保存した状態から戻す
--
--      中身を丸ごと置き換える操作なので、オーナーだけ。
--      控えたときの「作った人の名前」は残り、作った人の id は戻した人になる。
-- =============================================================================

reset role;
insert into public.snapshots (id, room_id, label, payload, author_id, author_name)
values (
  '99990000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'テスト用に控えたもの',
  jsonb_build_object('notes', jsonb_build_array(jsonb_build_object(
    'id',          '11110000-0000-0000-0000-000000000099',
    'room_id',     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'text',        '控えたときの付箋',
    'author_id',   '11111111-1111-1111-1111-111111111111',
    'author_name', 'むかしの人'
  ))),
  '11111111-1111-1111-1111-111111111111', 'ゆうき');
set local role authenticated;

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（編集できるが作った人ではない）

select throws_ok(
  $$select public.restore_snapshot('99990000-0000-0000-0000-000000000001')$$,
  'P0001', 'ボードを作った人だけが戻せます',
  '編集できる人でも、作った人でなければ戻せない');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（作った人）

select lives_ok(
  $$select public.restore_snapshot('99990000-0000-0000-0000-000000000001')$$,
  'オーナーは保存した状態に戻せる');

select is(
  (select author_name from public.notes where id = '11110000-0000-0000-0000-000000000099'),
  'むかしの人', '戻したあとも、控えたときの作った人の名前が残る');

select is(
  (select count(*)::int from public.notes
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, '戻すと、いまの中身は控えたときのものに置き換わる');


-- =============================================================================
--  32. 退出と、取り消しの片付け
--
--      「自分から抜けた」と「取り消された」は、行が残っているかで区別する。
--      抜けた人はまた入れるが、取り消された人は承認待ちに並ぶ。
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（16. で linkonly の参加者になった）

select is(
  tests_rowcount($$delete from public.room_members
                    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                      and user_id = '11111111-1111-1111-1111-111111111111'$$),
  1, '承認済みの人は、自分で退出できる');

select is(
  (select count(*)::int from public.notes
    where room_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  0, '退出すると、リンク公開でも中身は読めなくなる');

select is(
  public.request_access('linkonly', 'ゆうき'),
  'approved', '自分から抜けた人は、リンク公開ならまた入れる（取り消しとは違う）');

-- 取り消された人の行は、オーナーが片付ける。
-- 本人が消せると、行が無い状態からやり直せてしまう。
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（開いているボードのオーナー）

select is(
  tests_rowcount($$update public.room_members set status = 'rejected', decided_at = now()
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  1, 'オーナーはみなみのアクセスを取り消せる');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（取り消された）

select is(
  tests_rowcount($$delete from public.room_members
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  0, '取り消された人は、退出という形でも行を消せない');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select is(
  tests_rowcount($$delete from public.room_members
                    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  1, 'オーナーは、外した人の行を片付けられる');


-- =============================================================================
--  33. 合言葉の失敗回数は、自分では消せない
--
--      15. で止められた人が、退会して台帳ごと消せば、そのまま総当たりを
--      続けられてしまう。合言葉を当てようとしている人はまだ参加者ですら
--      ないので、退会に払う代償が無い。台帳はボードを守るためのもので、
--      本人の持ち物ではない。
-- =============================================================================

-- 前提の確認。15. の失敗記録が残っている（台帳は postgres でしか読めない）
reset role;
select is(
  (select failed_count from public.access_attempts
    where room_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
      and user_id = '44444444-4444-4444-4444-444444444444' and kind = 'pin'),
  5, '止められたままの記録が残っている');
set local role authenticated;

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select lives_ok(
  $$select public.delete_my_account()$$,
  '退会そのものはできる');

reset role;
select is(
  (select failed_count from public.access_attempts
    where room_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
      and user_id = '44444444-4444-4444-4444-444444444444' and kind = 'pin'),
  5, '退会しても、合言葉の失敗回数は消えない');
set local role authenticated;

-- 17. で止めた受付を開け直して、止められたままであることを確かめる
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（合言葉つきのボードのオーナー）

select is(
  tests_rowcount($$update public.rooms set join_closed = false
                    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$$),
  1, '受付を再開する');

select tests_act_as('44444444-4444-4444-4444-444444444444');   -- たかし

select throws_ok(
  $$select public.request_access('pinboard', 'たかし', '', 'ひみつのことば')$$,
  'P0001',
  '間違いが続いたため、10 分ほど待ってからやり直してください',
  '退会してやり直しても、まだ止められている');


-- =============================================================================
--  34. 「自分の行だから」だけでは通さない
--
--      書き込み（INSERT）は can_access_room と room_is_open を見ているのに、
--      書き換え（UPDATE）と取り消し（DELETE）が「自分の行か」しか見ていない、
--      という非対称。取り消されたあと・ボードが終わったあとに効いてくる。
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（承認制のボードのオーナー）

insert into public.notes (id, room_id, text, author_id, author_name)
values ('11110000-0000-0000-0000-000000000020', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        '相談ごと', '11111111-1111-1111-1111-111111111111', 'ゆうき');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ

insert into public.comments (id, room_id, target_type, body, author_id, author_name)
values ('77770000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'board', 'みなみの発言', '33333333-3333-3333-3333-333333333333', 'みなみ');

insert into public.note_votes (room_id, note_id, user_id, voter_name)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11110000-0000-0000-0000-000000000020',
        '33333333-3333-3333-3333-333333333333', 'みなみ');

-- 取り消されたあと。
-- ここは UPDATE / DELETE のポリシーではなく SELECT のポリシーが止めている
-- （行を見つけられないので 0 行）。理由が違うだけで結果は同じなので、
-- 「なぜ止まっているか」を変えたときに気づけるよう、両方を残しておく。
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき

select is(
  tests_rowcount($$update public.room_members set status = 'rejected', decided_at = now()
                    where room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  1, 'オーナーはみなみのアクセスを取り消せる');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（取り消された）

select is(
  (select count(*)::int from public.comments
    where room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  0, '取り消された人には、コメントはもう見えない');

select is(
  tests_rowcount($$update public.comments set body = 'あとから書き換えた'
                    where id = '77770000-0000-0000-0000-000000000002'$$),
  0, '取り消された人は、自分が書いたコメントも書き換えられない');

select is(
  tests_rowcount($$delete from public.note_votes
                    where room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
                      and user_id = '33333333-3333-3333-3333-333333333333'$$),
  0, '取り消された人は、自分が入れた票も取り下げられない');

-- ボードが終わったあと
select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（まだ参加者）

insert into public.comments (id, room_id, target_type, body, author_id, author_name)
values ('77770000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'board', 'けいこの発言', '22222222-2222-2222-2222-222222222222', 'けいこ');

insert into public.note_votes (room_id, note_id, user_id, voter_name)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11110000-0000-0000-0000-000000000020',
        '22222222-2222-2222-2222-222222222222', 'けいこ');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき

select is(
  tests_rowcount($$update public.rooms set archived = true
                    where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$),
  1, 'オーナーはボードを終了できる');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  (select count(*)::int from public.comments
    where id = '77770000-0000-0000-0000-000000000003'),
  1, '終了したボードでも、自分のコメントは読める');

select is(
  tests_rowcount($$update public.comments set body = '終わってから書き換えた'
                    where id = '77770000-0000-0000-0000-000000000003'$$),
  0, '終了したボードでは、自分が書いたコメントも書き換えられない');

select is(
  tests_rowcount($$delete from public.note_votes
                    where room_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
                      and user_id = '22222222-2222-2222-2222-222222222222'$$),
  0, '終了したボードでは、自分が入れた票も取り下げられない');


-- =============================================================================
--  35. 差し替えられて困る列は、UPDATE でも動かせない
--
--      INSERT はポリシーで確かめているのに、UPDATE では誰も見ていなかった列。
-- =============================================================================

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（開いているボードの編集できる人）

insert into public.images (id, room_id, storage_path, author_id, author_name)
values ('88880000-0000-0000-0000-000000000010', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/one.png',
        '22222222-2222-2222-2222-222222222222', 'けいこ');

insert into public.attachments (id, room_id, storage_path, filename, author_id, author_name)
values ('88880000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/one.pdf', '資料.pdf',
        '22222222-2222-2222-2222-222222222222', 'けいこ');

select is(
  tests_rowcount($$update public.images set x = 500
                    where id = '88880000-0000-0000-0000-000000000010'$$),
  1, '画像は動かせる');

select is(
  tests_error($$update public.images
                  set storage_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/two.png'
                where id = '88880000-0000-0000-0000-000000000010'$$),
  'storage_path は変更できません',
  '画像の実体の置き場所は差し替えられない（古い実体が消されないまま残るため）');

select is(
  tests_error($$update public.attachments
                  set storage_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/two.pdf'
                where id = '88880000-0000-0000-0000-000000000011'$$),
  'storage_path は変更できません',
  '添付の実体の置き場所も差し替えられない');

-- 通知は、受け取った人でも中身を書き換えられない（読んだ印だけ付けられる）
insert into public.notifications (id, room_id, user_id, kind, body, link_tab)
values ('99990000-0000-0000-0000-000000000010', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '22222222-2222-2222-2222-222222222222', 'mention', 'けいこあての知らせ', 'board');

select is(
  tests_rowcount($$update public.notifications set read = true
                    where id = '99990000-0000-0000-0000-000000000010'$$),
  1, '受け取った人は「読んだ」印を付けられる');

select is(
  tests_error($$update public.notifications set body = '書き換えた'
                where id = '99990000-0000-0000-0000-000000000010'$$),
  'body は変更できません',
  '受け取った人でも、通知の中身は書き換えられない');

select is(
  tests_error($$update public.notifications set actor_name = 'ゆうき'
                where id = '99990000-0000-0000-0000-000000000010'$$),
  'actor_name は変更できません',
  '差出人の名前も、あとから書き換えられない');


-- =============================================================================
--  36. これまで一度も触れていなかったところ
--
--      ポリシーもトリガーも書いてあるのに、テストが 1 件も無かったもの。
--      「書いたつもり」で終わっていないかを確かめる。
-- =============================================================================

-- ---- 復帰リンクの作り直し ------------------------------------------------
select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（オーナーではない）

select throws_ok(
  $$select public.rotate_owner_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'P0001', 'オーナーだけが変更できます',
  'オーナーでない人は、復帰リンクを作り直せない');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select isnt(
  public.rotate_owner_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (select recovery_token from tests_secrets
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'オーナーは復帰リンクを作り直せる（前とは違う値になる）');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and target_type = 'access' and action = 'owner_link_rotated'),
  1, '作り直したことが履歴に残る');

-- ---- 誰も触れないはずの台帳 ----------------------------------------------
select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

select is(
  (select count(*)::int from public.reminder_sends),
  0, 'リマインドの送信台帳は、ふつうの利用者からは見えない');

select is(
  tests_rowcount($$insert into public.reminder_sends (send_key) values ('でっちあげ')$$),
  -1, '送信台帳には書き込めない（二重送信を止める鍵なので）');

-- ---- 不具合の記録は置けるが、読み返せない --------------------------------
select is(
  tests_rowcount($$insert into public.client_errors (user_id, message)
                   values ('22222222-2222-2222-2222-222222222222', 'テストの記録')$$),
  1, '自分の不具合の記録は置ける');

select is(
  tests_rowcount($$insert into public.client_errors (user_id, message)
                   values ('11111111-1111-1111-1111-111111111111', '他人になりすました記録')$$),
  -1, '他人の名前では置けない');

select is(
  (select count(*)::int from public.client_errors),
  0, '置いた記録は、自分でも読み返せない（送りっぱなし）');

-- ---- 添付を消すと、実体の掃除が予約される（20. は画像だけ見ていた）--------
select is(
  tests_rowcount($$delete from public.attachments
                    where id = '88880000-0000-0000-0000-000000000011'$$),
  1, '添付の行を消せる');

reset role;
select is(
  (select count(*)::int from public.purge_queue
    where bucket = 'board-files' and kind = 'object'
      and path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/one.pdf'),
  1, '添付の行を消すと、その実体の掃除が 1 件予約される');
set local role authenticated;

-- ---- 日程調整の投票と、投票した人の名前 ----------------------------------
-- 29. で作った投票（88880000-…0001）を使う。候補日はまだ 1 件も無い
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき

select is(
  tests_rowcount($$insert into public.poll_options (id, poll_id, room_id, start_at)
                   values ('88880000-0000-0000-0000-000000000021',
                           '88880000-0000-0000-0000-000000000001',
                           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now())$$),
  1, '編集できる人は候補日を足せる');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ

insert into public.poll_votes (poll_id, option_id, room_id, user_id, voter_name)
values ('88880000-0000-0000-0000-000000000001', '88880000-0000-0000-0000-000000000021',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'ゆうき');

select is(
  (select voter_name from public.poll_votes
    where option_id = '88880000-0000-0000-0000-000000000021'
      and user_id = '22222222-2222-2222-2222-222222222222'),
  'けいこ', '日程調整の投票でも、名前は本人のものに直される');

select is(
  tests_rowcount($$insert into public.poll_votes (poll_id, option_id, room_id, user_id)
                   values ('88880000-0000-0000-0000-000000000001',
                           '88880000-0000-0000-0000-000000000021',
                           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                           '11111111-1111-1111-1111-111111111111')$$),
  -1, '他人になりかわって投票はできない');

-- ---- フレーム（囲み）------------------------------------------------------
select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき

select is(
  tests_rowcount($$insert into public.frames (id, room_id, title, author_id, author_name)
                   values ('88880000-0000-0000-0000-000000000030',
                           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '午前の案',
                           '11111111-1111-1111-1111-111111111111', 'ゆうき')$$),
  1, '編集できる人はフレームを作れる');

select tests_act_as('33333333-3333-3333-3333-333333333333');   -- みなみ（32. でこのボードの名簿から外れた）

select is(
  tests_rowcount($$insert into public.frames (room_id, title, author_id, author_name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '割り込み',
                           '33333333-3333-3333-3333-333333333333', 'みなみ')$$),
  -1, '参加していない人はフレームを作れない');


-- =============================================================================
--  37. 繰り返しの曜日指定は、DB でも形が決まっている
--
--      画面側（_shared/recurrence.ts の normalizeRule）と同じ決まりを、
--      DB の CHECK にも持たせてある。片方だけ直したときに気づけるよう、
--      ここで DB 側の判定そのものを見る。
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

-- 使い回す予定。id を固定しておく
select lives_ok(
  $$insert into public.events (id, room_id, title, start_at, recurrence, author_id, author_name)
     values ('88880000-0000-0000-0000-000000000040',
             'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '練習',
             '2026-09-01T10:00:00Z', 'weekly',
             '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '曜日を指定しない毎週は、これまでどおり作れる');

select throws_ok(
  $$update public.events set recurrence_days = array[7]::smallint[]
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '23514',
  null,
  '曜日は 0〜6 の外を受け付けない');

select throws_ok(
  $$update public.events set recurrence = 'daily', recurrence_days = array[2]::smallint[]
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '23514',
  null,
  '毎日には曜日を付けられない');

select throws_ok(
  $$update public.events set recurrence_week = 2
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '23514',
  null,
  '毎週には第 n 週を付けられない');

select throws_ok(
  $$update public.events
       set recurrence = 'monthly', recurrence_days = array[2]::smallint[], recurrence_week = 0
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '23514',
  null,
  '第 0 週は受け付けない');

select throws_ok(
  $$update public.events
       set recurrence = 'monthly',
           recurrence_days = array[2, 4]::smallint[],
           recurrence_week = 2
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '23514',
  null,
  '第 n 曜日に曜日を 2 つは持たせられない');

select lives_ok(
  $$update public.events set recurrence_days = array[2, 4]::smallint[]
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '毎週 火・木は保存できる');

select lives_ok(
  $$update public.events
       set recurrence = 'monthly',
           recurrence_days = array[2]::smallint[],
           recurrence_week = -1
     where id = '88880000-0000-0000-0000-000000000040'$$,
  '毎月 最終火曜も保存できる');

-- やること側も同じ形で守られている
select throws_ok(
  $$insert into public.todos (room_id, title, recurrence, recurrence_days, author_id, author_name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '掃除', 'yearly',
             array[2]::smallint[],
             '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  '23514',
  null,
  'やることも、毎年には曜日を付けられない');

select lives_ok(
  $$insert into public.todos (room_id, title, recurrence, recurrence_days, author_id, author_name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '掃除', 'weekly',
             array[2, 4]::smallint[],
             '11111111-1111-1111-1111-111111111111', 'ゆうき')$$,
  'やることも、毎週 火・木は保存できる');


-- =============================================================================
--  38. カレンダーの購読 URL
--
--      この URL を知っている人は、ボードに参加していなくても予定を読める。
--      発行できるのがオーナーだけであること、トークンが他の人からは見えないことを見る。
-- =============================================================================

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき（オーナー）

select matches(
  (select public.rotate_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  '^[0-9a-f]{32}$',
  'オーナーは購読 URL のトークンを発行できる');

select isnt(
  (select public.rotate_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  (select public.rotate_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  '作り直すたびに違うトークンになる');

select is(
  (select count(*)::int from public.activities
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and action = 'calendar_link_rotated'),
  3, '購読 URL の発行が 📣 更新に残る');

select tests_act_as('22222222-2222-2222-2222-222222222222');   -- けいこ（編集できる参加者）

select is(
  tests_error($$select public.rotate_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$),
  'オーナーだけが変更できます',
  '編集できる人でも購読 URL は発行できない');

select is(
  tests_error($$select public.clear_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$),
  'オーナーだけが変更できます',
  '編集できる人は購読 URL を止められない');

-- 参加者からはトークンそのものが見えない（room_secrets の SELECT はオーナー限定）
select is(
  (select count(*)::int from public.room_secrets
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0, '参加者は room_secrets を 1 行も読めない');

select tests_act_as('11111111-1111-1111-1111-111111111111');   -- ゆうき

select lives_ok(
  $$select public.clear_calendar_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'オーナーは購読 URL を止められる');

select is(
  (select calendar_token from public.room_secrets
    where room_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  null, '止めるとトークンは消える');


-- =============================================================================
--  39. 棚卸し — 権限の「形」を固定する
--
--      ここだけは中身ではなく形を見ている。ポリシーが増えた・減った、
--      トリガーが片方の操作にしか付いていない、外から呼べる関数が増えた——を、
--      次に誰かがやったときに気づけるようにする。
--
--      落ちたら、まず「その増減は意図したものか」を確かめること。
--      確かめてから一覧を直す。順番を逆にすると、この節は何も守らなくなる。
-- =============================================================================

reset role;

-- RLS を有効にし忘れたテーブルが無いこと。
-- ポリシーをいくら書いても、ここが漏れていればテーブルごと素通しになる。
select is(
  (select count(*)::int from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0, 'public のテーブルは、全部 RLS が有効');

-- ポリシーの顔ぶれ（テーブル・名前・対象の操作）。
-- 「これまで誰も触れなかった操作にポリシーが増えた」が、ここで見える。
select set_eq(
  $q$select tablename::text, policyname::text, cmd::text
       from pg_policies where schemaname = 'public'$q$,
  $q$values
  ('activities', 'activities_select', 'SELECT'),
  ('attachments', 'attachments_delete', 'DELETE'),
  ('attachments', 'attachments_insert', 'INSERT'),
  ('attachments', 'attachments_select', 'SELECT'),
  ('attachments', 'attachments_update', 'UPDATE'),
  ('calendar_feeds', 'calendar_feeds_delete', 'DELETE'),
  ('calendar_feeds', 'calendar_feeds_insert', 'INSERT'),
  ('calendar_feeds', 'calendar_feeds_select', 'SELECT'),
  ('calendar_feeds', 'calendar_feeds_update', 'UPDATE'),
  ('client_errors', 'client_errors_insert', 'INSERT'),
  ('comments', 'comments_delete', 'DELETE'),
  ('comments', 'comments_insert', 'INSERT'),
  ('comments', 'comments_select', 'SELECT'),
  ('comments', 'comments_update', 'UPDATE'),
  ('connectors', 'connectors_delete', 'DELETE'),
  ('connectors', 'connectors_insert', 'INSERT'),
  ('connectors', 'connectors_select', 'SELECT'),
  ('connectors', 'connectors_update', 'UPDATE'),
  ('event_overrides', 'event_overrides_delete', 'DELETE'),
  ('event_overrides', 'event_overrides_insert', 'INSERT'),
  ('event_overrides', 'event_overrides_select', 'SELECT'),
  ('event_overrides', 'event_overrides_update', 'UPDATE'),
  ('events', 'events_delete', 'DELETE'),
  ('events', 'events_insert', 'INSERT'),
  ('events', 'events_select', 'SELECT'),
  ('events', 'events_update', 'UPDATE'),
  ('frames', 'frames_delete', 'DELETE'),
  ('frames', 'frames_insert', 'INSERT'),
  ('frames', 'frames_select', 'SELECT'),
  ('frames', 'frames_update', 'UPDATE'),
  ('images', 'images_delete', 'DELETE'),
  ('images', 'images_insert', 'INSERT'),
  ('images', 'images_select', 'SELECT'),
  ('images', 'images_update', 'UPDATE'),
  ('note_reactions', 'note_reactions_delete', 'DELETE'),
  ('note_reactions', 'note_reactions_insert', 'INSERT'),
  ('note_reactions', 'note_reactions_select', 'SELECT'),
  ('note_reactions', 'note_reactions_update', 'UPDATE'),
  ('note_votes', 'note_votes_delete', 'DELETE'),
  ('note_votes', 'note_votes_insert', 'INSERT'),
  ('note_votes', 'note_votes_select', 'SELECT'),
  ('notes', 'notes_delete', 'DELETE'),
  ('notes', 'notes_insert', 'INSERT'),
  ('notes', 'notes_select', 'SELECT'),
  ('notes', 'notes_update', 'UPDATE'),
  ('notifications', 'notifications_delete', 'DELETE'),
  ('notifications', 'notifications_insert', 'INSERT'),
  ('notifications', 'notifications_select', 'SELECT'),
  ('notifications', 'notifications_update', 'UPDATE'),
  ('poll_options', 'poll_options_select', 'SELECT'),
  ('poll_options', 'poll_options_write', 'ALL'),
  ('poll_votes', 'poll_votes_delete', 'DELETE'),
  ('poll_votes', 'poll_votes_insert', 'INSERT'),
  ('poll_votes', 'poll_votes_select', 'SELECT'),
  ('poll_votes', 'poll_votes_update', 'UPDATE'),
  ('polls', 'polls_delete', 'DELETE'),
  ('polls', 'polls_insert', 'INSERT'),
  ('polls', 'polls_select', 'SELECT'),
  ('polls', 'polls_update', 'UPDATE'),
  ('push_subscriptions', 'push_subscriptions_all', 'ALL'),
  ('room_members', 'room_members_delete', 'DELETE'),
  ('room_members', 'room_members_insert', 'INSERT'),
  ('room_members', 'room_members_select', 'SELECT'),
  ('room_members', 'room_members_update', 'UPDATE'),
  ('room_secrets', 'room_secrets_select', 'SELECT'),
  ('rooms', 'rooms_delete', 'DELETE'),
  ('rooms', 'rooms_insert', 'INSERT'),
  ('rooms', 'rooms_select', 'SELECT'),
  ('rooms', 'rooms_update', 'UPDATE'),
  ('snapshots', 'snapshots_delete', 'DELETE'),
  ('snapshots', 'snapshots_insert', 'INSERT'),
  ('snapshots', 'snapshots_select', 'SELECT'),
  ('snapshots', 'snapshots_update', 'UPDATE'),
  ('strokes', 'strokes_delete', 'DELETE'),
  ('strokes', 'strokes_insert', 'INSERT'),
  ('strokes', 'strokes_select', 'SELECT'),
  ('strokes', 'strokes_update', 'UPDATE'),
  ('todos', 'todos_delete', 'DELETE'),
  ('todos', 'todos_insert', 'INSERT'),
  ('todos', 'todos_select', 'SELECT'),
  ('todos', 'todos_update', 'UPDATE')
  $q$,
  'RLS ポリシーの顔ぶれが、控えと一致する');

-- トリガーの顔ぶれ（テーブル・名前・タイミング・対象の操作）。
--
-- 「門番が片方の操作にしか居ない」がひと目で分かる形にしてある。
-- 実際、rooms_limit_per_user が INSERT だけを見ていたせいで、オーナー復帰で
-- ボードの上限をすり抜けられた。room_members_guard が UPDATE だけなのは
-- 意図したもの（理由は schema.sql の room_members_delete のコメント）。
select set_eq(
  $q$select event_object_table::text, trigger_name::text, action_timing::text,
            string_agg(distinct event_manipulation::text, ',' order by event_manipulation::text)
       from information_schema.triggers
      where trigger_schema = 'public'
      group by 1, 2, 3$q$,
  $q$values
  ('attachments', 'attachments_enqueue_purge', 'AFTER', 'DELETE'),
  ('attachments', 'attachments_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('attachments', 'attachments_freeze', 'BEFORE', 'UPDATE'),
  ('attachments', 'attachments_freeze_path', 'BEFORE', 'UPDATE'),
  ('attachments', 'attachments_limit_rows', 'BEFORE', 'INSERT'),
  ('attachments', 'attachments_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('calendar_feeds', 'calendar_feeds_freeze', 'BEFORE', 'UPDATE'),
  ('calendar_feeds', 'calendar_feeds_limit_rows', 'BEFORE', 'INSERT'),
  ('calendar_feeds', 'calendar_feeds_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('client_errors', 'client_errors_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('client_errors', 'client_errors_throttle', 'BEFORE', 'INSERT'),
  ('comments', 'comments_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('comments', 'comments_freeze', 'BEFORE', 'UPDATE'),
  ('comments', 'comments_limit_rows', 'BEFORE', 'INSERT'),
  ('comments', 'comments_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('connectors', 'connectors_freeze', 'BEFORE', 'UPDATE'),
  ('connectors', 'connectors_limit_rows', 'BEFORE', 'INSERT'),
  ('connectors', 'connectors_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('event_overrides', 'event_overrides_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('event_overrides', 'event_overrides_freeze', 'BEFORE', 'UPDATE'),
  ('event_overrides', 'event_overrides_limit_rows', 'BEFORE', 'INSERT'),
  ('event_overrides', 'event_overrides_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('events', 'events_activity', 'AFTER', 'DELETE,INSERT,UPDATE'),
  ('events', 'events_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('events', 'events_freeze', 'BEFORE', 'UPDATE'),
  ('events', 'events_limit_rows', 'BEFORE', 'INSERT'),
  ('events', 'events_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('events', 'events_touch', 'BEFORE', 'UPDATE'),
  ('frames', 'frames_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('frames', 'frames_freeze', 'BEFORE', 'UPDATE'),
  ('frames', 'frames_limit_rows', 'BEFORE', 'INSERT'),
  ('frames', 'frames_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('images', 'images_activity', 'AFTER', 'DELETE,INSERT,UPDATE'),
  ('images', 'images_enqueue_purge', 'AFTER', 'DELETE'),
  ('images', 'images_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('images', 'images_freeze', 'BEFORE', 'UPDATE'),
  ('images', 'images_freeze_path', 'BEFORE', 'UPDATE'),
  ('images', 'images_limit_rows', 'BEFORE', 'INSERT'),
  ('images', 'images_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('note_reactions', 'note_reactions_freeze', 'BEFORE', 'UPDATE'),
  ('note_reactions', 'note_reactions_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('note_votes', 'note_votes_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('note_votes', 'note_votes_freeze', 'BEFORE', 'UPDATE'),
  ('note_votes', 'note_votes_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('notes', 'notes_activity', 'AFTER', 'DELETE,INSERT,UPDATE'),
  ('notes', 'notes_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('notes', 'notes_freeze', 'BEFORE', 'UPDATE'),
  ('notes', 'notes_limit_rows', 'BEFORE', 'INSERT'),
  ('notes', 'notes_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('notes', 'notes_touch', 'BEFORE', 'UPDATE'),
  ('notifications', 'notifications_freeze', 'BEFORE', 'UPDATE'),
  ('notifications', 'notifications_freeze_body', 'BEFORE', 'UPDATE'),
  ('notifications', 'notifications_guard', 'BEFORE', 'INSERT'),
  ('notifications', 'notifications_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('poll_options', 'poll_options_freeze', 'BEFORE', 'UPDATE'),
  ('poll_options', 'poll_options_limit_rows', 'BEFORE', 'INSERT'),
  ('poll_votes', 'poll_votes_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('poll_votes', 'poll_votes_freeze', 'BEFORE', 'UPDATE'),
  ('poll_votes', 'poll_votes_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('polls', 'polls_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('polls', 'polls_freeze', 'BEFORE', 'UPDATE'),
  ('polls', 'polls_limit_rows', 'BEFORE', 'INSERT'),
  ('polls', 'polls_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('room_members', 'room_members_access_log', 'AFTER', 'DELETE,INSERT,UPDATE'),
  ('room_members', 'room_members_freeze', 'BEFORE', 'UPDATE'),
  ('room_members', 'room_members_guard', 'BEFORE', 'UPDATE'),
  ('room_members', 'room_members_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('rooms', 'rooms_access_log', 'AFTER', 'UPDATE'),
  ('rooms', 'rooms_create_secret', 'AFTER', 'INSERT'),
  ('rooms', 'rooms_enqueue_purge', 'BEFORE', 'DELETE'),
  ('rooms', 'rooms_limit_per_user', 'BEFORE', 'INSERT,UPDATE'),
  ('rooms', 'rooms_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('snapshots', 'snapshots_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('snapshots', 'snapshots_freeze', 'BEFORE', 'UPDATE'),
  ('snapshots', 'snapshots_limit_rows', 'BEFORE', 'INSERT'),
  ('snapshots', 'snapshots_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('strokes', 'strokes_freeze', 'BEFORE', 'UPDATE'),
  ('strokes', 'strokes_limit_rows', 'BEFORE', 'INSERT'),
  ('strokes', 'strokes_limit_text', 'BEFORE', 'INSERT,UPDATE'),
  ('todos', 'todos_activity', 'AFTER', 'DELETE,INSERT,UPDATE'),
  ('todos', 'todos_force_name', 'BEFORE', 'INSERT,UPDATE'),
  ('todos', 'todos_freeze', 'BEFORE', 'UPDATE'),
  ('todos', 'todos_guard_assignee', 'BEFORE', 'INSERT,UPDATE'),
  ('todos', 'todos_limit_rows', 'BEFORE', 'INSERT'),
  ('todos', 'todos_limit_text', 'BEFORE', 'INSERT,UPDATE')
  $q$,
  'トリガーの顔ぶれと、守っている操作が、控えと一致する');

-- ログイン済みの人が実行できる public の関数。
--
-- 増えていたら、それは新しい入口。RPC を足したとき以外に増えてはいけない。
-- tg_ で始まるものは戻り値が trigger なので、SQL からも PostgREST からも
-- 直接は呼べない（それでも一覧には出るので、ここに並べておく）。
-- 拡張（pgtap）の関数と、このテストが作る tests_ の助っ人は数えない。
select set_eq(
  $q$select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and not exists (select 1 from pg_depend d
                         where d.objid = p.oid and d.deptype = 'e')
        and p.proname not like 'tests\_%'$q$,
  $q$values
  ('can_access_room'),
  ('can_edit_room'),
  ('claim_owner'),
  ('clear_calendar_token'),
  ('delete_my_account'),
  ('get_room_preview'),
  ('is_room_owner'),
  ('is_room_participant'),
  ('my_membership_status'),
  ('realtime_room_id'),
  ('request_access'),
  ('restore_snapshot'),
  ('revoke_all_members'),
  ('room_display_name'),
  ('room_is_open'),
  ('rotate_calendar_token'),
  ('rotate_owner_token'),
  ('rotate_room_slug'),
  ('set_join_pin'),
  ('storage_room_id'),
  ('tg_create_room_secret'),
  ('tg_enqueue_purge'),
  ('tg_enqueue_purge_room'),
  ('tg_force_author_name'),
  ('tg_force_voter_name'),
  ('tg_freeze_columns'),
  ('tg_guard_member_update'),
  ('tg_guard_notification'),
  ('tg_guard_todo_assignee'),
  ('tg_limit_rooms_per_user'),
  ('tg_limit_rows_per_room'),
  ('tg_limit_text'),
  ('tg_log_activity'),
  ('tg_log_member_access'),
  ('tg_log_room_access'),
  ('tg_throttle_client_errors'),
  ('tg_touch_event_updated_at'),
  ('tg_touch_note_updated_at')
  $q$,
  'ログイン済みの人が呼べる関数が、控えと一致する');

set local role authenticated;

select * from finish();

rollback;
