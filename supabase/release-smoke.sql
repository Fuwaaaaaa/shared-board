-- =============================================================================
--  みんなのボード — 本番へ schema.sql を流したあとの確認
-- -----------------------------------------------------------------------------
--  通知の「まとめ（digest）」を入れたときに、アプリ側が前提にしている
--  DB の変更が本当に効いているかだけを見ます。
--
--    1. notifications.folded_count 列がある
--    2. kind の制約が 'digest' を許す
--    3. ふつうの通知が作れる
--    4. 上限を超えた通知が digest の 1 行になる
--    5. そのあとは folded_count が増えるだけで、行は増えない
--
--  ここが揃っていないと、通知が多いときの INSERT が制約で落ちます
--  ——「通知が出ない」という形でしか気づけないので、流したら必ず確かめてください。
--
--  実行のしかた
--
--    A) Supabase の SQL Editor に貼って実行
--    B) psql -f supabase/release-smoke.sql
--
--  すべてトランザクションの中で行い、最後に巻き戻します。
--  使い捨てのボードを 1 つ作りますが、**行はすべて ROLLBACK され、永続データは残りません**。
--  本番でそのまま実行できます。
--
--  「何も残らない」ではなく「行が残らない」と書いているのは、PostgreSQL では
--  nextval() の消費だけは ROLLBACK されないためです。番号に穴が開くだけで実害は
--  ありませんが、正確ではないので分けて書いています。
--  いまのこのファイルはシーケンスを 1 つも動かしません —— 触るのは rooms と
--  notifications だけで、どちらも主キーが uuid（gen_random_uuid）です。
--  public のシーケンスは purge_queue_id_seq の 1 本だけで、ここからは触りません
--  （2 回続けて実行して値が動かないことを確かめてあります）。
--
--  トランザクションの外に出る副作用もありません。schema.sql のトリガーには
--  pg_net の呼び出しが 1 つもなく（外へ出るのは cron.sql の定期実行だけで、
--  そちらは INSERT では動きません）、ここから通知やメールは飛びません。
--
--  pgTAP は要りません（本番には入っていないため）。
--  日々の回帰は supabase/tests/rls.test.sql（pgTAP）の担当です。
--
--  supabase/tests/ の下に置いていないのは、`supabase test db` がその下の .sql を
--  全部 pgTAP のテストとして拾ってしまうためです（このファイルには plan が
--  無いので、混ぜると必ず失敗します。_stub_storage.sql と同じ理由）。
-- =============================================================================

begin;

/*
 * 流した schema.sql が「どの commit のものか」を、記録の 1 行に入れるための欄。
 *
 * DB は git を知らないので、ここだけは人が渡します。渡さなくても動きます
 * （記録の 1 行が「commit 未記入」になるだけ）。
 *
 *   Supabase の SQL Editor … 次の行のコメントを外して、
 *                            git rev-parse --short HEAD の結果を貼る
 *   psql                   … 触らずに、この行を先に流し込む
 *                            （docs/SETUP.md に貼れるコマンドがあります）
 *
 * ここを「空文字で毎回上書きする」形にはしていません。そうすると、
 * 先に渡した値を消してしまい、psql から渡す手が使えなくなるためです。
 *
 * set local なので、この後の rollback で必ず消えます。
 */
-- set local app.commit_sha = 'a1b2c3d';

create temporary table _smoke (
  step   text,
  ok     boolean,
  detail text
) on commit drop;


-- ---- 1〜2. 形が揃っているか（カタログを読むだけ） ---------------------------

insert into _smoke
select '1. notifications.folded_count 列がある',
       count(*) = 1,
       coalesce(string_agg(data_type || ' / 既定 ' || coalesce(column_default, 'なし'), ', '),
                '列がありません（schema.sql が未適用です）')
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'notifications'
   and column_name  = 'folded_count';

insert into _smoke
select '2. kind の制約が digest を許す',
       coalesce(bool_or(pg_get_constraintdef(oid) like '%digest%'), false),
       coalesce(max(pg_get_constraintdef(oid)), '制約がありません')
  from pg_constraint
 where conrelid = 'public.notifications'::regclass
   and conname  = 'notifications_kind_check';


-- ---- 3〜5. 実際に通知を作ってみる -------------------------------------------
--
-- 途中で落ちても結果表が出るように、内側の block で受け止めます。

do $$
declare
  v_room   uuid := gen_random_uuid();
  v_user   uuid := gen_random_uuid();
  v_owner  uuid := gen_random_uuid();
  -- slug は ^[0-9a-z]{6,32}$
  v_slug   text := 'smoke' || substr(md5(random()::text), 1, 12);
  v_rows   integer;
  v_digest integer;
  v_folded integer;
  v_ok3    boolean;
  v_ok4    boolean;
  v_ok5    boolean;
  v_d3     text;
  v_d4     text;
  v_d5     text;
begin
  begin
    insert into public.rooms (id, slug, name, owner_id, owner_name)
    values (v_room, v_slug, 'リリース前の確認', v_owner, '確認');

    -- 3. ふつうの通知
    insert into public.notifications (room_id, user_id, kind, body, link_tab)
    values (v_room, v_user, 'mention', '確認 1', 'board');

    select count(*) into v_rows from public.notifications where room_id = v_room;
    v_ok3 := v_rows = 1;
    v_d3  := v_rows || ' 件';

    -- high の枠（毎分 20 件）を埋める
    for i in 2..20 loop
      insert into public.notifications (room_id, user_id, kind, body, link_tab)
      values (v_room, v_user, 'mention', '確認 ' || i, 'board');
    end loop;

    -- 4. 溢れた 1 件目が digest になる
    insert into public.notifications (room_id, user_id, kind, body, link_tab)
    values (v_room, v_user, 'mention', '21 件目', 'board');

    select count(*) into v_digest
      from public.notifications where room_id = v_room and kind = 'digest';
    v_ok4 := v_digest = 1;
    v_d4  := 'digest の行 ' || v_digest || ' 件';

    -- 5. そのあとは足されるだけ
    insert into public.notifications (room_id, user_id, kind, body, link_tab)
    values (v_room, v_user, 'mention', '22 件目', 'board');

    select folded_count into v_folded
      from public.notifications where room_id = v_room and kind = 'digest';
    select count(*) into v_rows from public.notifications where room_id = v_room;

    v_ok5 := v_folded = 2 and v_rows = 21;
    v_d5  := 'folded_count=' || v_folded || ' / 行数=' || v_rows || '（20 + まとめ 1 を期待）';

    insert into _smoke values
      ('3. ふつうの通知が作れる',                       v_ok3, v_d3),
      ('4. 溢れた通知が digest の 1 行になる',          v_ok4, v_d4),
      ('5. folded_count が増え、行は増えない',          v_ok5, v_d5);

  exception when others then
    insert into _smoke values
      ('3-5. 通知を作ってみる', false, '失敗: ' || SQLERRM || '（SQLSTATE ' || SQLSTATE || '）');
  end;
end $$;


-- ---- 結果 -------------------------------------------------------------------

select step        as "確認したこと",
       case when ok then 'OK' else 'NG' end as "結果",
       detail      as "実測"
  from _smoke
 order by step;

select case when bool_and(ok)
            then 'すべて通りました。本番の schema.sql は最新です。'
            else 'NG があります。supabase/schema.sql を流し直してください。'
       end as "まとめ"
  from _smoke;

-- あとから「この本番 DB はどこまで入っているか」を辿れるように、
-- この 1 行を git のタグへ貼ってください（docs/SETUP.md を参照）
select 'schema 適用 '
       || to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST'
       -- commit が入っていれば、タグを見なくてもこの 1 行だけで
       -- 「どの本番 DB に、どのコードの schema が入っているか」が分かる
       || ' / commit '
       || coalesce(nullif(current_setting('app.commit_sha', true), ''), '未記入')
       || ' / release-smoke '
       -- 通らなかったときに「n/m OK」とだけ書くと、貼った先で通ったように読める。
       -- 判定そのものを先に出す
       || case when bool_and(ok)
               then count(*) || '/' || count(*) || ' OK'
               else 'NG（' || count(*) filter (where ok) || '/' || count(*) || '）——貼らないでください'
          end
       as "リリース記録に残す 1 行"
  from _smoke;

rollback;
