-- =============================================================================
--  みんなのボード — Supabase スキーマ
-- -----------------------------------------------------------------------------
--  Supabase ダッシュボード → SQL Editor に、このファイルの内容を丸ごと貼り付けて
--  「Run」してください。何度実行しても同じ状態になります（冪等）。
--
--  前提: Authentication → Sign In / Providers で「Anonymous sign-ins」を有効化。
-- =============================================================================


-- =============================================================================
--  1. テーブル
-- =============================================================================

-- ルーム（1つの共有スペース）。中にホワイトボード・カレンダー・TODO を持つ。
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,                       -- URL に使う短いコード
  name        text not null,
  visibility  text not null default 'public'
              check (visibility in ('public', 'private')),
  owner_id    uuid not null,                              -- 作成者の auth.uid()
  owner_name  text not null default '',
  created_at  timestamptz not null default now()
);

-- ルームのオーナー復帰トークン。rooms とは別テーブルにして、
-- 「公開ルームは誰でも SELECT できる」状態でもトークンが漏れないようにする。
create table if not exists public.room_secrets (
  room_id        uuid primary key references public.rooms(id) on delete cascade,
  recovery_token text not null
);

-- ルームの参加者。非公開ルームでは status='pending' が「承認待ちの申請」になる。
create table if not exists public.room_members (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  user_id      uuid not null,
  display_name text not null default '',
  role         text not null default 'member' check (role in ('owner', 'member')),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  message      text not null default '',                  -- 参加申請のひとこと
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  unique (room_id, user_id)
);

-- ホワイトボードの付箋
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  x           double precision not null default 100,
  y           double precision not null default 100,
  w           double precision not null default 220,
  h           double precision not null default 170,
  color       text not null default 'yellow',
  text        text not null default '',
  z           integer not null default 0,
  author_id   uuid not null,
  author_name text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ホワイトボードの手描きストローク（1本 = 1行）
create table if not exists public.strokes (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  points     jsonb not null,                              -- [[x, y], [x, y], ...]
  color      text not null default '#1f2937',
  width      double precision not null default 3,
  author_id  uuid not null,
  created_at timestamptz not null default now()
);

-- カレンダーの予定
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  title       text not null,
  description text not null default '',
  start_at    timestamptz not null,
  end_at      timestamptz,
  all_day     boolean not null default true,
  color       text not null default 'blue',
  author_id   uuid not null,
  author_name text not null default '',
  created_at  timestamptz not null default now()
);

-- 繰り返し予定の「この回だけ」の変更・削除。
-- occurrence_date は「元の回」の開始日で、その回を別の日へ動かしてもこの値は変わらない。
-- 対応している繰り返しは 毎日 / 毎週 / 毎月 / 毎年 なので、1 予定につき 1 日 1 回しか
-- 出現しない。だから (event_id, occurrence_date) が回の一意キーとして成立する。
-- 曜日指定（recurrence_days / recurrence_week）を足してもこの前提は変わらない。
-- 「毎週 火・木」は各曜日が週に 1 回、「毎月 第 2 火曜」は月に 1 回しか出ない。
create table if not exists public.event_overrides (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms(id) on delete cascade,
  event_id        uuid not null references public.events(id) on delete cascade,
  occurrence_date date not null,
  canceled        boolean not null default false,           -- true なら「この回は削除」
  -- 「変更」の行は差分ではなく、表示に必要な値を丸ごと持つ。
  -- end_at を「未指定」と「終了なし」で兼用すると区別できなくなるため。
  title           text,
  description     text,
  start_at        timestamptz,
  end_at          timestamptz,                              -- null = 終了時刻なし
  all_day         boolean,
  color           text,
  remind_minutes  integer,
  tags            text[],
  author_id       uuid not null,
  author_name     text not null default '',
  created_at      timestamptz not null default now(),
  unique (event_id, occurrence_date),
  constraint event_overrides_shape
    check (canceled or (title is not null and start_at is not null))
);

-- リマインド / TODO
create table if not exists public.todos (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms(id) on delete cascade,
  title         text not null,
  notes         text not null default '',
  due_at        timestamptz,                              -- 期限なしは null
  done          boolean not null default false,
  done_at       timestamptz,
  assignee_name text not null default '',
  author_id     uuid not null,
  author_name   text not null default '',
  created_at    timestamptz not null default now()
);

-- ホワイトボードに貼った画像（実体は Storage、ここには配置情報だけ）
create table if not exists public.images (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  storage_path text not null,                            -- '<room_id>/<uuid>.png'
  x            double precision not null default 120,
  y            double precision not null default 120,
  w            double precision not null default 320,
  h            double precision not null default 240,
  z            integer not null default 0,
  author_id    uuid not null,
  author_name  text not null default '',
  created_at   timestamptz not null default now()
);

-- 付箋どうしをつなぐ線。位置は付箋から計算するので座標は持たない。
create table if not exists public.connectors (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  from_note_id uuid not null references public.notes(id) on delete cascade,
  to_note_id   uuid not null references public.notes(id) on delete cascade,
  style        text not null default 'arrow' check (style in ('arrow', 'line')),
  color        text not null default '#64748b',
  label        text not null default '',
  author_id    uuid not null,
  created_at   timestamptz not null default now()
);

-- 領域を囲って名前をつけるフレーム
create table if not exists public.frames (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  x           double precision not null default 100,
  y           double precision not null default 100,
  w           double precision not null default 600,
  h           double precision not null default 400,
  title       text not null default '',
  color       text not null default 'slate',
  z           integer not null default 0,
  author_id   uuid not null,
  author_name text not null default '',
  created_at  timestamptz not null default now()
);

-- 付箋への絵文字リアクション
create table if not exists public.note_reactions (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  note_id    uuid not null references public.notes(id) on delete cascade,
  user_id    uuid not null,
  emoji      text not null,
  created_at timestamptz not null default now(),
  unique (note_id, user_id, emoji)
);

-- ボードに置いたファイル（PDF など）
create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  storage_path text not null,
  filename     text not null,
  mime         text not null default '',
  size         bigint not null default 0,
  x            double precision not null default 120,
  y            double precision not null default 120,
  z            integer not null default 0,
  author_id    uuid not null,
  author_name  text not null default '',
  created_at   timestamptz not null default now()
);

-- 日程調整
create table if not exists public.polls (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.rooms(id) on delete cascade,
  title             text not null,
  description       text not null default '',
  status            text not null default 'open' check (status in ('open', 'closed')),
  decided_option_id uuid,
  author_id         uuid not null,
  author_name       text not null default '',
  created_at        timestamptz not null default now()
);

create table if not exists public.poll_options (
  id       uuid primary key default gen_random_uuid(),
  poll_id  uuid not null references public.polls(id) on delete cascade,
  room_id  uuid not null references public.rooms(id) on delete cascade,
  start_at timestamptz not null,
  end_at   timestamptz,
  all_day  boolean not null default false,
  sort     integer not null default 0
);

create table if not exists public.poll_votes (
  id         uuid primary key default gen_random_uuid(),
  poll_id    uuid not null references public.polls(id) on delete cascade,
  option_id  uuid not null references public.poll_options(id) on delete cascade,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null,
  voter_name text not null default '',
  answer     text not null default 'yes' check (answer in ('yes', 'maybe', 'no')),
  created_at timestamptz not null default now(),
  unique (option_id, user_id)
);

-- 外部カレンダー（.ics 公開 URL）の購読設定
create table if not exists public.calendar_feeds (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  name       text not null,
  url        text not null,
  color      text not null default 'slate',
  enabled    boolean not null default true,
  author_id  uuid not null,
  created_at timestamptz not null default now()
);

-- サイト内通知（@メンションなど）。user_id が宛先。
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null,
  actor_name text not null default '',
  kind       text not null default 'mention',
  body       text not null default '',
  link_tab   text not null default 'board',
  link_id    uuid,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

-- 付箋への投票（ドット投票）
create table if not exists public.note_votes (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  note_id    uuid not null references public.notes(id) on delete cascade,
  user_id    uuid not null,
  voter_name text not null default '',
  created_at timestamptz not null default now(),
  unique (note_id, user_id)
);

-- 変更履歴。トリガーから書き込むだけで、クライアントからは書き込めない。
create table if not exists public.activities (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  actor_id     uuid,
  actor_name   text not null default '',
  action       text not null,                            -- created / updated / deleted / completed …
  target_type  text not null,                            -- notes / events / todos / images / access
  target_label text not null default '',
  created_at   timestamptz not null default now()
);

-- Web プッシュ通知の送信先（1 ブラウザにつき 1 行）
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

-- 送信済みの通知を覚えておき、二重送信を防ぐ（Edge Function が使う）
create table if not exists public.reminder_sends (
  send_key text primary key,
  sent_at  timestamptz not null default now()
);

-- 合言葉・オーナー復帰トークンの失敗回数。
-- 総当たりを止めるためのもので、成功したら行ごと消す（RPC の内側だけが触る。ポリシーは無い）。
create table if not exists public.access_attempts (
  room_id        uuid not null references public.rooms(id) on delete cascade,
  user_id        uuid not null,
  kind           text not null check (kind in ('pin', 'owner')),
  failed_count   integer not null default 0,
  last_failed_at timestamptz not null default now(),
  primary key (room_id, user_id, kind)
);

-- Storage の実体を消す予約。
--
-- 画像や添付の行を消したとき・ボードごと消したときに、トリガーがここへ積む。
-- SQL から storage.objects を直接 delete してはいけない。あれは storage-api の台帳で、
-- 行を消しても S3 側の実体は残ってしまう（容量だけ食い続ける）。
-- 実体は purge-storage Edge Function が Storage API 経由で消し、消せた行をここから落とす。
-- kind='object' は 1 ファイル、'prefix' は '<room_id>/' 以下のフォルダ丸ごと。
create table if not exists public.purge_queue (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  kind       text not null default 'object' check (kind in ('object', 'prefix')),
  path       text not null,
  queued_at  timestamptz not null default now(),
  attempts   integer not null default 0,
  last_error text
);

-- ブラウザ側で起きたエラー（window.onerror / unhandledrejection）。
-- 誰でも自分の分だけ INSERT できる。読むのはダッシュボードの SQL Editor から。
-- room_id には FK を張らない（ボードが消えたあともエラーは残しておきたい）。
create table if not exists public.client_errors (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  room_id    uuid,
  message    text not null,
  stack      text not null default '',
  url        text not null default '',
  ua         text not null default '',
  created_at timestamptz not null default now()
);

-- ボードの保存点。会議の終わりなど「この状態」を丸ごと控えておく。
-- payload には付箋・手描き・線・フレーム・予定・やること・画像の行をそのまま入れる。
create table if not exists public.snapshots (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  label       text not null default '',
  payload     jsonb not null,
  author_id   uuid not null,
  author_name text not null default '',
  created_at  timestamptz not null default now()
);

-- コメント / チャット
-- target_type='board' はボード全体のチャット、それ以外は付箋・予定・TODO に紐づく
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  target_type text not null default 'board'
              check (target_type in ('board', 'note', 'event', 'todo')),
  target_id   uuid,
  body        text not null,
  author_id   uuid not null,
  author_name text not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists notes_room_idx   on public.notes (room_id);
create index if not exists strokes_room_idx on public.strokes (room_id, created_at);
create index if not exists events_room_idx  on public.events (room_id, start_at);
create index if not exists event_overrides_idx on public.event_overrides (room_id, event_id, occurrence_date);
create index if not exists todos_room_idx   on public.todos (room_id, due_at);
create index if not exists members_room_idx on public.room_members (room_id);
create index if not exists members_user_idx on public.room_members (user_id);
create index if not exists images_room_idx   on public.images (room_id);
create index if not exists comments_room_idx on public.comments (room_id, target_type, target_id, created_at);
create index if not exists votes_room_idx    on public.note_votes (room_id, note_id);
create index if not exists activities_idx    on public.activities (room_id, created_at desc);
create index if not exists push_user_idx     on public.push_subscriptions (user_id);
create index if not exists connectors_room_idx  on public.connectors (room_id);
create index if not exists frames_room_idx      on public.frames (room_id);
create index if not exists reactions_note_idx   on public.note_reactions (room_id, note_id);
create index if not exists attachments_room_idx on public.attachments (room_id);
create index if not exists polls_room_idx       on public.polls (room_id, created_at desc);
create index if not exists poll_options_idx     on public.poll_options (room_id, poll_id, sort);
create index if not exists poll_votes_idx       on public.poll_votes (room_id, option_id);
create index if not exists feeds_room_idx       on public.calendar_feeds (room_id);
create index if not exists notifications_idx    on public.notifications (user_id, read, created_at desc);
create index if not exists snapshots_room_idx   on public.snapshots (room_id, created_at desc);
create index if not exists rooms_owner_idx      on public.rooms (owner_id);
create index if not exists access_attempts_idx  on public.access_attempts (room_id, kind, last_failed_at);
create index if not exists purge_queue_idx      on public.purge_queue (queued_at);
create index if not exists client_errors_idx    on public.client_errors (user_id, created_at desc);


-- =============================================================================
--  1.5 既存テーブルへの追加カラム
--      すでに前のバージョンを実行済みでも、このファイルを流し直せば追いつきます。
-- =============================================================================

-- ホワイトボード: 手描きに加えて図形（直線 / 矢印 / 四角 / 円）を保存できるようにする。
-- 図形の points は始点と終点の 2 点だけを持つ。
alter table public.strokes
  add column if not exists kind text not null default 'free'
  check (kind in ('free', 'line', 'arrow', 'rect', 'ellipse'));

-- カレンダー: 終了時刻・繰り返し・事前通知
alter table public.events
  add column if not exists recurrence text not null default 'none'
  check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly'));
alter table public.events add column if not exists recurrence_until date;
alter table public.events add column if not exists remind_minutes integer;

-- リマインド: 担当者の紐づけ・事前通知・繰り返し・サブタスク
alter table public.todos add column if not exists assignee_id uuid;
alter table public.todos add column if not exists remind_minutes integer;
alter table public.todos
  add column if not exists recurrence text not null default 'none'
  check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly'));
alter table public.todos
  add column if not exists subtasks jsonb not null default '[]'::jsonb;

-- 繰り返しの曜日指定。
--
--   recurrence_days  毎週: 出す曜日（0=日 … 6=土）。空なら開始日の曜日だけ（従来どおり）
--                    毎月: 「第 n 曜日」のときの曜日を 1 つだけ持つ
--   recurrence_week  毎月: 第 n 週（1〜5、-1 は最終週）。null なら開始日と同じ日付で繰り返す
--
-- どちらも既定値が「これまでと同じ意味」になるようにしてある。この列より前からある
-- 予定は展開結果が 1 日も変わらないので、event_overrides の対応づけ（occurrence_date）
-- も崩れない。移行の話はこれで全部で、既存の行に書き足すものはない。
--
-- 第 n 曜日の曜日を start_at から導かずに持つのは、開始日を編集したときに
-- 「第 2 火曜」が黙って「第 2 水曜」に化けないようにするため。
-- 書き出す RRULE（BYDAY=2TU）も、この曜日をそのまま使う。
--
-- 同じ曜日を 2 回入れることは CHECK では弾けない（副問い合わせが書けない）。
-- 画面側の normalizeRule が並べ替えと重複除去をし、展開側も同じ回を 2 度は出さない。
alter table public.events add column if not exists recurrence_days smallint[] not null default '{}';
alter table public.events add column if not exists recurrence_week smallint;
alter table public.todos  add column if not exists recurrence_days smallint[] not null default '{}';
alter table public.todos  add column if not exists recurrence_week smallint;

alter table public.events drop constraint if exists events_recurrence_days_check;
alter table public.events add constraint events_recurrence_days_check check (
  cardinality(recurrence_days) <= 7
  and recurrence_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
  and (recurrence in ('weekly', 'monthly') or cardinality(recurrence_days) = 0)
  and (recurrence_week is null or cardinality(recurrence_days) = 1)
) not valid;

alter table public.events drop constraint if exists events_recurrence_week_check;
alter table public.events add constraint events_recurrence_week_check check (
  recurrence_week is null
  or (recurrence = 'monthly' and recurrence_week between -1 and 5 and recurrence_week <> 0)
) not valid;

alter table public.todos drop constraint if exists todos_recurrence_days_check;
alter table public.todos add constraint todos_recurrence_days_check check (
  cardinality(recurrence_days) <= 7
  and recurrence_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
  and (recurrence in ('weekly', 'monthly') or cardinality(recurrence_days) = 0)
  and (recurrence_week is null or cardinality(recurrence_days) = 1)
) not valid;

alter table public.todos drop constraint if exists todos_recurrence_week_check;
alter table public.todos add constraint todos_recurrence_week_check check (
  recurrence_week is null
  or (recurrence = 'monthly' and recurrence_week between -1 and 5 and recurrence_week <> 0)
) not valid;

-- 参加者ごとの編集権限。false なら「閲覧・コメント・投票だけ」できる。
alter table public.room_members add column if not exists can_edit boolean not null default true;

-- 付箋は「ふせん」と「テキストボックス（枠なしの文字）」の 2 種類
alter table public.notes
  add column if not exists kind text not null default 'sticky'
  check (kind in ('sticky', 'text'));

-- 付箋の文字サイズ（px）。0 は「まだ決めていない」で、種類ごとの既定を使う。
-- 既定値を 0 にしてあるので、この列より前からある付箋の見た目は変わらない。
alter table public.notes
  add column if not exists font_size integer not null default 0
  check (font_size = 0 or (font_size >= 10 and font_size <= 64));

-- タグ（付箋・予定・TODO 共通）
alter table public.notes  add column if not exists tags text[] not null default '{}';
alter table public.events add column if not exists tags text[] not null default '{}';
alter table public.todos  add column if not exists tags text[] not null default '{}';

-- リマインドのカンバン表示用。done フラグとは別に列を持つ。
alter table public.todos
  add column if not exists status text not null default 'todo'
  check (status in ('todo', 'doing', 'done'));
alter table public.todos add column if not exists sort_order double precision not null default 0;

-- ボードの終了状態と、参加者ごとのお気に入り。
-- archived = true は「終了したボード」。中身はそのまま読めるが、
-- 付箋・予定・やること・コメント・投票のどれも新しくは書けなくなる（room_is_open を参照）。
alter table public.rooms        add column if not exists archived boolean not null default false;
alter table public.room_members add column if not exists favorite boolean not null default false;

-- 出自の紐づけ。
-- 「この付箋から生まれた予定・やること」をたどれるようにする。
-- 元を消しても行き先は残したいので on delete set null。
alter table public.todos
  add column if not exists source_note_id uuid references public.notes(id) on delete set null;
alter table public.todos
  add column if not exists source_event_id uuid references public.events(id) on delete set null;
alter table public.events
  add column if not exists source_note_id uuid references public.notes(id) on delete set null;

-- 出自との同期。
--
-- 付箋から生まれた やること / 予定 は、作ったあとは別のものとして扱う（自動では追随しない）。
-- 共同編集で勝手に上書きされると、何が起きたのか誰にも分からなくなるため。
-- 代わりに「作った時点での元の updated_at」を控えておき、元が変わったときだけ
-- 「元が変更されています」と知らせて、反映するかどうかを選べるようにする。
alter table public.events add column if not exists updated_at timestamptz not null default now();
alter table public.todos  add column if not exists source_synced_at timestamptz;
alter table public.events add column if not exists source_synced_at timestamptz;

-- 予定と締切の区別。
-- 「9/20 に集金する」と「9/20 が集金の〆切」は意味が違うので、
-- 締切はカレンダーの終日欄に控えめに出す。
alter table public.events
  add column if not exists kind text not null default 'event'
  check (kind in ('event', 'deadline'));

-- 共有リンクの安全機能。
--
-- 合言葉は room_secrets 側に置き、しかも平文では持たない（bcrypt のハッシュだけ）。
-- 以前は join_pin に平文で入れていたが、オーナーの画面に合言葉を出し直す用途しか無く、
-- 万一 DB の中身が漏れたときに合言葉がそのまま読めるのは割に合わない。
--
-- pgcrypto は extensions スキーマに置く（Supabase の標準の置き場所。public に置くと
-- search_path を空にした security definer 関数から呼べない）。
create extension if not exists pgcrypto with schema extensions;

alter table public.room_secrets add column if not exists pin_hash text;

-- 旧 join_pin 列が残っていれば、一度だけハッシュ化して列ごと落とす。
-- 列が無い環境（新規・移行済み）では何もしない。join_pin を参照する SQL は
-- 列が無いと構文解析の段階で落ちるので、execute で文字列として渡す。
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'room_secrets' and column_name = 'join_pin'
  ) then
    execute $q$
      update public.room_secrets
         set pin_hash = extensions.crypt(btrim(join_pin), extensions.gen_salt('bf', 10))
       where coalesce(btrim(join_pin), '') <> ''
         and pin_hash is null
    $q$;
    execute 'alter table public.room_secrets drop column join_pin';
  end if;
end;
$$;

-- カレンダーの購読 URL のトークン。
--
-- カレンダーアプリは JWT を送れないので、URL に埋めた 32 桁の乱数そのものが鍵になる。
-- 発行は任意で、既定は null（発行していない）。ここを既定で埋めてしまうと、
-- すでにあるボードが黙って「URL を知っていれば誰でも予定を読める」状態になる。
--
-- 置き場所を room_secrets にするのは、この表が
--   ・リアルタイム配信に入っていない
--   ・SELECT のポリシーがオーナーだけに限られている
--   ・ボードを消せば一緒に消える
-- という、必要な性質をすでに全部持っているため。新しい表を作ると、RLS の有効化・
-- ポリシー 4 つ・棚卸しの行・リアルタイムの判断・件数上限がぜんぶ付いてくる。
alter table public.room_secrets add column if not exists calendar_token text;
alter table public.room_secrets add column if not exists calendar_token_at timestamptz;

-- トークンからボードを引くのは board-ics（service_role）だけ。索引が無いと
-- 総当たりのたびに全表走査になる。部分一意にして重複も防ぐ。
create unique index if not exists room_secrets_calendar_token_uidx
  on public.room_secrets (calendar_token) where calendar_token is not null;

alter table public.rooms add column if not exists join_closed     boolean not null default false;
alter table public.rooms add column if not exists join_expires_at timestamptz;
alter table public.rooms add column if not exists max_members     integer;

-- ゴミ箱。消したものは 30 日ぶん残して、戻せるようにする。
--
-- 共同編集では Ctrl+Z が自分の操作にしか効かないため、
-- 「他の人が消したものを戻す」手段がこれまで無かった。
alter table public.notes  add column if not exists deleted_at timestamptz;
alter table public.events add column if not exists deleted_at timestamptz;
alter table public.todos  add column if not exists deleted_at timestamptz;
alter table public.images add column if not exists deleted_at timestamptz;

create index if not exists notes_deleted_idx  on public.notes  (room_id, deleted_at);
create index if not exists events_deleted_idx on public.events (room_id, deleted_at);
create index if not exists todos_deleted_idx  on public.todos  (room_id, deleted_at);
create index if not exists images_deleted_idx on public.images (room_id, deleted_at);

-- 通知の種類。増やすときはここと src/lib/types.ts の NOTIFICATION_KINDS を合わせる。
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('mention', 'assigned', 'converted', 'join_request', 'join_decided'));

-- 通知のジャンプ先タブ。src/components/RoomHeader.tsx の TabKey と同じ集合。
-- ここが自由だと、任意の文字列がプッシュ通知のリンクとして端末に配られる。
alter table public.notifications drop constraint if exists notifications_link_tab_check;
alter table public.notifications
  add constraint notifications_link_tab_check
  check (link_tab in ('board', 'calendar', 'todo', 'updates', 'dashboard')) not valid;

create index if not exists todos_source_note_idx   on public.todos  (room_id, source_note_id);
create index if not exists todos_source_event_idx  on public.todos  (room_id, source_event_id);
create index if not exists events_source_note_idx  on public.events (room_id, source_note_id);

-- 繰り返しのやることを完了したとき、次回分がどの行から生まれたか。
--
-- FK は張らない。元の行は cron の物理削除で消えることがあり、保存した状態から
-- 戻すときは元の行より先に次回分が入ることもあるため。
-- 「同じ元から生まれた未完了の次回分は 1 件だけ」は部分一意インデックスで守る
-- （2 つのタブで同時に完了しても次回分が 2 つにならない）。
alter table public.todos add column if not exists source_todo_id uuid;

create unique index if not exists todos_next_occurrence_uidx on public.todos (source_todo_id)
  where source_todo_id is not null and done = false and deleted_at is null;
create index if not exists todos_source_todo_idx on public.todos (room_id, source_todo_id);


-- =============================================================================
--  1.6 上限
--      列の長さとタグの個数に天井を付ける。画面側の maxLength は REST を直接叩けば
--      素通りできるので、DB で止める。
--
--      実行順は「トリガー → CHECK 制約」なので、ふつうはトリガーの日本語の文言で止まる。
--      CHECK 制約は、トリガーを外されたときや将来の別経路のための二重の壁。
--      not valid を付けているのは、既に上限を超えている行があっても追加に失敗しないため
--      （新しい書き込みには効く。既存行の検証だけ省く）。
-- =============================================================================

-- 引数は (列名, 上限, 列名, 上限, ...) の繰り返し。
-- to_jsonb(NEW) から列名で引くので、テーブルごとに関数を分けなくてよい。
-- jsonb の列（strokes.points など）は JSON 文字列としての長さで測る。
create or replace function public.tg_limit_text()
returns trigger language plpgsql as $$
declare
  v_row jsonb;
  v_col text;
  v_max integer;
  v_val text;
  i     integer := 0;
begin
  v_row := to_jsonb(NEW);
  while i + 1 < TG_NARGS loop
    v_col := TG_ARGV[i];
    v_max := TG_ARGV[i + 1]::integer;
    v_val := v_row ->> v_col;
    if v_val is not null and length(v_val) > v_max then
      raise exception '% は % 文字までです', v_col, v_max using errcode = 'check_violation';
    end if;
    i := i + 2;
  end loop;
  return NEW;
end;
$$;

-- 上限の一覧。ここを直せばトリガーと CHECK 制約の両方が作り直される。
-- 書式は 'テーブル.列:上限'。列名は上の create table にあるものだけを書くこと
-- （無い列を書くと、そのテーブルへの書き込みがすべて落ちる）。
do $$
declare
  v_limits text[] := array[
    'rooms.name:100',              'rooms.owner_name:30',
    'rooms.slug:32',
    'room_members.display_name:30','room_members.message:200',
    'notes.text:5000',             'notes.author_name:30',
    -- 手描き 1 本の点列。2px 間引きで約 4,800 点ぶん入る（十分に長い一筆書き）。
    -- 以前は 200000 で、1 ボード上限 5000 本と掛け合わせると 1 本のボードで
    -- 無料枠を使い切れてしまったため下げている。
    'strokes.points:120000',
    'events.title:200',            'events.description:5000',
    'events.author_name:30',
    'event_overrides.title:200',   'event_overrides.description:5000',
    'event_overrides.author_name:30',
    'todos.title:200',             'todos.notes:5000',
    'todos.subtasks:20000',        'todos.assignee_name:30',
    'todos.author_name:30',
    'comments.body:2000',          'comments.author_name:30',
    'images.storage_path:300',     'images.author_name:30',
    'attachments.storage_path:300','attachments.filename:255',
    'attachments.mime:150',        'attachments.author_name:30',
    'connectors.label:200',
    'frames.title:200',            'frames.author_name:30',
    'polls.title:200',             'polls.description:2000',
    'polls.author_name:30',
    'poll_votes.voter_name:30',
    'note_votes.voter_name:30',
    'note_reactions.emoji:16',
    'calendar_feeds.name:100',     'calendar_feeds.url:2000',
    'notifications.body:500',      'notifications.actor_name:30',
    'notifications.link_tab:20',
    'snapshots.label:60',          'snapshots.payload:3000000',
    'client_errors.message:1000',  'client_errors.stack:5000',
    'client_errors.url:500',       'client_errors.ua:300'
  ];
  r record;
begin
  -- CHECK 制約（列ごと）
  for r in
    select split_part(x, '.', 1)                        as tbl,
           split_part(split_part(x, '.', 2), ':', 1)    as col,
           split_part(x, ':', 2)::integer               as max_len
      from unnest(v_limits) as x
  loop
    execute format('alter table public.%I drop constraint if exists %I',
                   r.tbl, r.tbl || '_' || r.col || '_len');
    execute format('alter table public.%I add constraint %I check (length(%I::text) <= %s) not valid',
                   r.tbl, r.tbl || '_' || r.col || '_len', r.col, r.max_len);
  end loop;

  -- トリガー（テーブルごとに 1 本。引数に列と上限を並べて渡す）
  for r in
    select tbl, string_agg(format('%L, %L', col, max_len), ', ' order by col) as args
      from (
        select split_part(x, '.', 1)                      as tbl,
               split_part(split_part(x, '.', 2), ':', 1)  as col,
               split_part(x, ':', 2)::integer             as max_len
          from unnest(v_limits) as x
      ) as v
     group by tbl
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_limit_text', r.tbl);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.tg_limit_text(%s)',
      r.tbl || '_limit_text', r.tbl, r.args);
  end loop;

  -- タグの個数
  for r in select unnest(array['notes', 'events', 'todos']) as tbl loop
    execute format('alter table public.%I drop constraint if exists %I', r.tbl, r.tbl || '_tags_count');
    execute format('alter table public.%I add constraint %I check (cardinality(tags) <= 20) not valid',
                   r.tbl, r.tbl || '_tags_count');
  end loop;
end;
$$;


-- =============================================================================
--  1.7 所属ルームの整合性（複合外部キー）
--
--      子テーブルは room_id と「親の id」を別々に持っている。RLS が見るのは room_id
--      だけなので、ちぐはぐな行 ——「自分のボードの room_id」＋「他人のボードの親 id」
--      —— を作れてしまうと、自分のボードへの書き込み権限だけで他人のボードの
--      ふるまいに手を出せてしまう。
--
--      実害が出るのが event_overrides だった。送信側（send-reminders Edge Function）は
--      service_role で動くので RLS を素通りし、しかも event_id だけで例外行を引く。
--      そのため他人の予定の「この回だけ」を乗っ取れた:
--        - canceled = true  → 相手のボードのプッシュ通知を恒久的に止める
--        - title / start_at → 相手のボードの参加者全員に任意の文言を任意の時刻に配る
--      さらに (event_id, occurrence_date) が一意なので、本来のボードは正しい例外行を
--      作れなくなり、その行は相手のボードからは見ることも消すこともできない。
--
--      直し方は「room_id ごと参照する複合外部キー」にすること。親に (id, room_id) の
--      ユニーク制約を足し、子の外部キーを (親の id, room_id) の 2 列にする。
--      これで所属の一致を DB が保証するので、RLS もアプリも room_id だけ見ればよくなる。
-- =============================================================================

-- 親側: 複合外部キーの参照先になるユニーク制約
do $$
declare
  r record;
begin
  for r in select unnest(array['notes', 'events', 'polls', 'poll_options']) as tbl loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', r.tbl)::regclass
         and conname  = r.tbl || '_id_room_key'
    ) then
      execute format('alter table public.%I add constraint %I unique (id, room_id)',
                     r.tbl, r.tbl || '_id_room_key');
    end if;
  end loop;
end;
$$;

-- 子側: 単独列の外部キーを (親の id, room_id) の複合に張り替える。
-- 旧制約名は create table が自動採番した <表>_<列>_fkey。
--
-- 既に所属のずれた行がある DB では、この追加が落ちてスクリプト全体が止まる。
-- 黙って通すよりそのほうがよい（下の select で洗い出せる）:
--   select id, room_id, event_id from public.event_overrides o
--    where not exists (select 1 from public.events e
--                       where e.id = o.event_id and e.room_id = o.room_id);
do $$
declare
  r record;
begin
  for r in select * from (values
    -- (子テーブル, 子の列, 旧制約名, 新制約名, 親テーブル)
    ('event_overrides', 'event_id',     'event_overrides_event_id_fkey', 'event_overrides_event_room_fkey', 'events'),
    ('poll_options',    'poll_id',      'poll_options_poll_id_fkey',     'poll_options_poll_room_fkey',     'polls'),
    ('poll_votes',      'poll_id',      'poll_votes_poll_id_fkey',       'poll_votes_poll_room_fkey',       'polls'),
    ('poll_votes',      'option_id',    'poll_votes_option_id_fkey',     'poll_votes_option_room_fkey',     'poll_options'),
    ('note_votes',      'note_id',      'note_votes_note_id_fkey',       'note_votes_note_room_fkey',       'notes'),
    ('note_reactions',  'note_id',      'note_reactions_note_id_fkey',   'note_reactions_note_room_fkey',   'notes'),
    ('connectors',      'from_note_id', 'connectors_from_note_id_fkey',  'connectors_from_note_room_fkey',  'notes'),
    ('connectors',      'to_note_id',   'connectors_to_note_id_fkey',    'connectors_to_note_room_fkey',    'notes')
  ) as v(child, col, old_name, new_name, parent)
  loop
    execute format('alter table public.%I drop constraint if exists %I', r.child, r.old_name);
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', r.child)::regclass
         and conname  = r.new_name
    ) then
      execute format(
        'alter table public.%I add constraint %I
           foreign key (%I, room_id) references public.%I (id, room_id) on delete cascade',
        r.child, r.new_name, r.col, r.parent);
    end if;
  end loop;
end;
$$;

-- Storage のパスは必ず自分のボードのフォルダ配下に限る。
--
-- storage_path は削除トリガーがそのまま purge_queue に積み、purge-storage が
-- service_role で消しに行く値。ここが自由だと、他人のボードのファイルを消させたり、
-- 逆に「まだ参照されている」と誤認させて相手のファイルを消えなくしたりできる。
-- storage.objects 側の RLS もパスの先頭フォルダで判定しているので、
-- DB の行とストレージ実体の所属は必ず一致していなければならない。
do $$
declare
  r record;
begin
  for r in select unnest(array['images', 'attachments']) as tbl loop
    execute format('alter table public.%I drop constraint if exists %I',
                   r.tbl, r.tbl || '_path_scope');
    execute format(
      'alter table public.%I add constraint %I check (storage_path like room_id::text || ''/%%'') not valid',
      r.tbl, r.tbl || '_path_scope');
  end loop;
end;
$$;

-- 共有リンクの slug は「英小文字と数字だけ」。
-- rooms_update はオーナーに全列の更新を許すので、ここが自由だと数MBの値や
-- '/' '?' '#' を入れられ、プッシュ通知が組み立てる URL（SITE_URL/r/<slug>）が壊れる。
-- 生成側は gen_random_uuid() の先頭 10 文字なので、この形に収まる。
alter table public.rooms drop constraint if exists rooms_slug_shape;
alter table public.rooms
  add constraint rooms_slug_shape check (slug ~ '^[0-9a-z]{6,32}$') not valid;


-- =============================================================================
--  2. 権限判定ヘルパー
--     RLS ポリシーの中から他テーブルを直接参照すると、そのテーブルの RLS も
--     評価されて無限再帰になる。security definer 関数に逃がして回避する。
--
--     security definer の関数はすべて `set search_path = ''` を付け、
--     テーブルも関数も public. / auth. で完全修飾する。
--     探索パスに頼ると、public に同じ名前のものを置かれたときに
--     そちらが呼ばれてしまい、定義者（postgres）の権限で動いてしまうため。
-- =============================================================================

-- 以前ここにあった room_is_public は消した。
-- 読み書きの判定には使っておらず（リンク公開でも、参加登録した人しか読めない）、
-- request_access も rooms.visibility を直接見ている。呼び出し元が無いまま
-- security definer で authenticated に開いていると、ボードの id を当てた人に
-- 「そのボードがリンク公開かどうか」だけを教えることになる。
drop function if exists public.room_is_public(uuid);

create or replace function public.is_room_owner(rid uuid)
returns boolean language sql security definer stable
set search_path = '' as $$
  select exists (select 1 from public.rooms r where r.id = rid and r.owner_id = auth.uid());
$$;

-- 自分のそのルームでの参加状態（未申請なら null）
create or replace function public.my_membership_status(rid uuid)
returns text language sql security definer stable
set search_path = '' as $$
  select m.status from public.room_members m
   where m.room_id = rid and m.user_id = auth.uid()
   limit 1;
$$;

-- その人がそのボードの「関係者」か（オーナー、または room_members に行がある人。
-- 承認待ち・取り消し済みも含む）。
-- 通知の宛先ややることの担当者など、「このボードと無関係な人を指していないか」を
-- 確かめるときに使う。読める・書けるの判定には使わない。
create or replace function public.is_room_participant(rid uuid, uid uuid)
returns boolean language sql security definer stable
set search_path = '' as $$
  select uid is not null and (
    exists (select 1 from public.rooms r where r.id = rid and r.owner_id = uid)
    or exists (select 1 from public.room_members m where m.room_id = rid and m.user_id = uid)
  );
$$;

-- ルームの中身を「読んで」よいか。
-- オーナーか、承認済みの参加者だけ。リンク公開のボードでも、URL を開いただけの人は
-- request_access で参加登録が済むまで読めない（登録は画面側が自動で行う）。
-- 以前は visibility='public' なら誰でも読めたが、それだと URL を総当たりされたときに
-- 中身が丸ごと見える。「読める人 = 参加者一覧に載っている人」に揃える。
create or replace function public.can_access_room(rid uuid)
returns boolean language sql security definer stable
set search_path = '' as $$
  select public.is_room_owner(rid)
      or public.my_membership_status(rid) = 'approved';
$$;

-- ボードが「開いて」いるか（＝終了していないか）。
-- 終了したボードは中身をそのまま読めるが、新しい書き込みは誰にもできない。
-- 合宿や文化祭が終わったあと、「削除する」と「使い続ける」の間を埋めるための状態。
create or replace function public.room_is_open(rid uuid)
returns boolean language sql security definer stable
set search_path = '' as $$
  select not exists (select 1 from public.rooms r where r.id = rid and r.archived);
$$;

-- ルームの中身を「書き換えて」よいか。
-- 終了したボードでは、オーナーを含めて誰も書き換えられない。
-- そのうえで、オーナーは常に可。参加者は can_edit フラグ次第。
-- 参加登録していない人は、リンク公開のボードでも書けない（読めないのだから当然）。
create or replace function public.can_edit_room(rid uuid)
returns boolean language sql security definer stable
set search_path = '' as $$
  select public.room_is_open(rid) and case
    when public.is_room_owner(rid) then true
    when exists (
      select 1 from public.room_members m
       where m.room_id = rid and m.user_id = auth.uid() and m.status = 'approved'
    ) then coalesce((
      select m.can_edit from public.room_members m
       where m.room_id = rid and m.user_id = auth.uid()
    ), false)
    else false
  end;
$$;

-- 「いま書き込もうとしている人」の表示名。
--
-- 参加者一覧の display_name を正とする。オーナーはまだ room_members に行が無い
-- ことがある（ボードを作った直後・複製した直後）ので、そのときは rooms.owner_name。
-- どちらも無ければ空文字。author_name の上書き（tg_force_author_name）で使う。
create or replace function public.room_display_name(p_room uuid)
returns text language sql security definer stable
set search_path = '' as $$
  select coalesce(
    (select m.display_name from public.room_members m
      where m.room_id = p_room and m.user_id = auth.uid() limit 1),
    (select r.owner_name from public.rooms r
      where r.id = p_room and r.owner_id = auth.uid()),
    '');
$$;


-- =============================================================================
--  3. トリガー
-- =============================================================================

-- ルーム作成時にオーナー復帰トークンを自動発行する
create or replace function public.tg_create_room_secret()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  insert into public.room_secrets (room_id, recovery_token)
  values (new.id, replace(gen_random_uuid()::text, '-', ''))
  on conflict (room_id) do nothing;
  return new;
end;
$$;

drop trigger if exists rooms_create_secret on public.rooms;
create trigger rooms_create_secret
  after insert on public.rooms
  for each row execute function public.tg_create_room_secret();

-- オーナー以外は room_members の status / role / can_edit を書き換えられないようにする。
-- （承認・却下・編集権限の付与はオーナーだけの権限。
--   これが無いと「閲覧のみ」の人が自分に編集権限を付けられてしまう）
--
-- 唯一の例外が「もう一度申請する」。本人の行を
-- 却下 -> 承認待ち に戻すときだけ通す。並ぶだけで、何も読めるようにはならない
-- （承認するかどうかはオーナーが決める）。
--
-- ただし通すのは request_access を通ったときだけにする。
-- 「却下 -> 承認待ち なら誰の UPDATE でも通す」にすると、受付停止・参加期限・
-- 人数上限・合言葉の判定をすり抜けて承認待ちの列に並べてしまう
-- （room_members への直接 INSERT を禁じているのと同じ理由。下の INSERT ポリシー参照）。
--
-- そこで request_access が、戻す行の id を目印に置いてから UPDATE する。
-- 目印はトランザクションの中だけで生き（set_config の第 3 引数）、
-- 読んだその場で消すので、同じトランザクションの後続の更新には効かない。
-- 値が行の id なので、別の行にも効かない。set_config は pg_catalog にあり、
-- PostgREST が公開する public には無いので、外から立てることもできない
-- （app.skip_access_log・app.restoring_snapshot と同じ作り）。
create or replace function public.tg_guard_member_update()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if public.is_room_owner(new.room_id) then
    return new;
  end if;

  if coalesce(pg_catalog.current_setting('app.reapply_member', true), '') = old.id::text
     and new.user_id  = old.user_id
     and new.user_id  = auth.uid()
     and old.status   = 'rejected'
     and new.status   = 'pending'
     and new.role     is not distinct from old.role
     and new.can_edit is not distinct from old.can_edit
  then
    -- 目印は使い捨て。ここで消さないと、同じトランザクションの次の更新まで通る
    perform pg_catalog.set_config('app.reapply_member', '', true);
    return new;
  end if;

  new.status     := old.status;
  new.role       := old.role;
  new.can_edit   := old.can_edit;
  new.decided_at := old.decided_at;
  return new;
end;
$$;

drop trigger if exists room_members_guard on public.room_members;
create trigger room_members_guard
  before update on public.room_members
  for each row execute function public.tg_guard_member_update();

-- 付箋の updated_at を自動更新。
--
-- updated_at は「この付箋から作った やること / 予定 に、元の変更を知らせるか」の
-- 判定に使う。動かした・大きさを変えた・色を変えただけで知らせると邪魔になるので、
-- 中身（本文とタグ）が実際に変わったときだけ進める。
create or replace function public.tg_touch_note_updated_at()
returns trigger language plpgsql as $$
begin
  if (new.text, new.tags) is distinct from (old.text, old.tags) then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists notes_touch on public.notes;
create trigger notes_touch
  before update on public.notes
  for each row execute function public.tg_touch_note_updated_at();

-- 予定の updated_at も同じ考え方で更新する（「準備すること」への知らせに使う）
create or replace function public.tg_touch_event_updated_at()
returns trigger language plpgsql as $$
begin
  if (new.title, new.description, new.start_at, new.end_at, new.all_day, new.tags)
     is distinct from (old.title, old.description, old.start_at, old.end_at, old.all_day, old.tags)
  then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists events_touch on public.events;
create trigger events_touch
  before update on public.events
  for each row execute function public.tg_touch_event_updated_at();

-- 旧・共通版（付箋だけが使っていた）。上の 2 つに置き換えたので、あれば片付ける。
drop function if exists public.tg_touch_updated_at();

-- 通知の差出人名を自己申告させない。
--
-- notifications の INSERT ポリシーは「同じボードを見られる人なら誰でも」なので、
-- actor_name をそのまま信じると他人の名前で通知を送れてしまう。
-- 送った本人の表示名で必ず上書きする。
create or replace function public.tg_guard_notification()
returns trigger language plpgsql security definer
set search_path = '' as $$
declare
  v_name text;
begin
  select m.display_name into v_name
    from public.room_members m
   where m.room_id = new.room_id and m.user_id = auth.uid()
   limit 1;

  new.actor_name := coalesce(v_name, '');
  return new;
end;
$$;

drop trigger if exists notifications_guard on public.notifications;
create trigger notifications_guard
  before insert on public.notifications
  for each row execute function public.tg_guard_notification();

-- 付箋・予定・コメントなどの「書いた人の名前」も自己申告させない。
--
-- RLS が強制しているのは author_id = auth.uid() だけで、author_name はこれまで
-- クライアントの言い値だった。つまり閲覧のみの参加者でも、チャットに
-- author_name = '（オーナーの表示名）' で「このリンクから合言葉を入れ直して」と
-- 書き込めてしまう。名前が同じ人を見分ける仕組み（src/lib/names.ts）は
-- room_members にしか効かないので、画面上は本人と区別が付かない。
-- 通知と同じように、必ず本人の表示名で上書きする。
--
-- 例外は「保存した状態からの復元」だけ。控えたときの作成者名を残すため、
-- restore_snapshot の中でだけ app.restoring_snapshot が立つ。
-- PostgREST は 1 リクエスト = 1 トランザクションなので、この抑止フラグを
-- 外から立てて次のリクエストへ持ち越すことはできない。
-- 更新のときは「今の人の名前で上書き」ではなく「変えさせない」。
-- 付箋を動かす・中身を直すのは書いた本人とは限らないので、上書きにすると
-- 他人の付箋をドラッグしただけで作成者が入れ替わってしまう。
create or replace function public.tg_force_author_name()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if coalesce(pg_catalog.current_setting('app.restoring_snapshot', true), '')
       = NEW.room_id::text then
    return NEW;
  end if;

  if TG_OP = 'UPDATE' then
    NEW.author_name := OLD.author_name;
    return NEW;
  end if;

  NEW.author_name := public.room_display_name(NEW.room_id);
  return NEW;
end;
$$;

-- 投票した人の名前も同じ扱い（列名だけが違う）
create or replace function public.tg_force_voter_name()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    NEW.voter_name := OLD.voter_name;
    return NEW;
  end if;

  NEW.voter_name := public.room_display_name(NEW.room_id);
  return NEW;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('notes',           'author'), ('events',      'author'),
      ('event_overrides', 'author'), ('todos',       'author'),
      ('images',          'author'), ('attachments', 'author'),
      ('frames',          'author'), ('polls',       'author'),
      ('comments',        'author'), ('snapshots',   'author'),
      ('note_votes',      'voter'),  ('poll_votes',  'voter')
    ) as v(tbl, col)
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_force_name', r.tbl);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.tg_force_%s_name()',
      r.tbl || '_force_name', r.tbl, r.col);
  end loop;
end;
$$;

-- 変更履歴を書き込む。
-- 付箋の移動やドラッグまで残すと履歴が埋まってしまうので、
-- 「作成・削除」と「中身が実際に変わった更新」だけを記録する。
create or replace function public.tg_log_activity()
returns trigger language plpgsql security definer
set search_path = '' as $$
declare
  v_room   uuid;
  v_action text;
  v_label  text;
  v_actor  uuid := auth.uid();
  v_name   text;
  v_keep   boolean := true;
begin
  if TG_OP = 'DELETE' then
    v_room := OLD.room_id;
    v_action := 'deleted';
  else
    v_room := NEW.room_id;
    v_action := case when TG_OP = 'INSERT' then 'created' else 'updated' end;
  end if;

  if TG_TABLE_NAME = 'notes' then
    v_label := left(coalesce(case when TG_OP = 'DELETE' then OLD.text else NEW.text end, ''), 60);
    if TG_OP = 'UPDATE' then
      v_keep := NEW.text is distinct from OLD.text;
    end if;

  elsif TG_TABLE_NAME = 'events' then
    v_label := case when TG_OP = 'DELETE' then OLD.title else NEW.title end;
    if TG_OP = 'UPDATE' then
      v_keep := (NEW.title, NEW.start_at, NEW.end_at) is distinct from (OLD.title, OLD.start_at, OLD.end_at);
    end if;

  elsif TG_TABLE_NAME = 'todos' then
    v_label := case when TG_OP = 'DELETE' then OLD.title else NEW.title end;
    if TG_OP = 'UPDATE' then
      v_keep := (NEW.title, NEW.due_at, NEW.done, NEW.assignee_id)
                is distinct from (OLD.title, OLD.due_at, OLD.done, OLD.assignee_id);
      if NEW.done is distinct from OLD.done then
        v_action := case when NEW.done then 'completed' else 'reopened' end;
      end if;
    end if;

  elsif TG_TABLE_NAME = 'images' then
    v_label := '画像';
  end if;

  -- 論理削除は UPDATE として届く。ゴミ箱に入れた／戻したことは必ず残す。
  if TG_OP = 'UPDATE' and NEW.deleted_at is distinct from OLD.deleted_at then
    v_action := case when NEW.deleted_at is null then 'restored' else 'deleted' end;
    v_keep := true;
  end if;

  if not v_keep then
    return null;
  end if;

  select m.display_name into v_name
    from public.room_members m
   where m.room_id = v_room and m.user_id = v_actor
   limit 1;

  insert into public.activities (room_id, actor_id, actor_name, action, target_type, target_label)
  values (v_room, v_actor, coalesce(v_name, ''), v_action, TG_TABLE_NAME, coalesce(v_label, ''));

  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['notes', 'events', 'todos', 'images'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_activity', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function public.tg_log_activity()',
      t || '_activity', t);
  end loop;
end;
$$;


-- アクセスまわりの出来事も、同じ変更履歴に残す。
--
-- ログイン不要のサービスでは「いつ誰が入ってきたか」「誰が権限を変えたか」が
-- いちばん確かめたくなるところなので、付箋や予定と 1 本の流れにまとめる。
-- target_type は 'access' 固定、target_label には相手の名前や設定の内容を入れる。
--
-- クライアントから直接呼べると履歴を偽造できてしまうので、実行権限は最後に取り上げる。
create or replace function public.log_access(
  p_room       uuid,
  p_action     text,
  p_label      text default '',
  -- 退出は自分の参加行が消えたあとに呼ばれるので、名前を引けない。そのとき渡す
  p_actor_name text default null
)
returns void language plpgsql security definer
set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
begin
  -- 「全員を外す」のような一括処理の途中は、まとめて 1 行だけ残したいので黙る。
  --
  -- フラグには対象のボードの id を入れる。'on' のような汎用の値にすると、
  -- どこかで立ちっぱなしになったときに、関係のないボードの記録まで黙って落ちる。
  -- なおこの GUC は pg_catalog.set_config でしか変えられず、その関数は
  -- PostgREST が公開するスキーマ（public）に無いので、外から立てる経路は無い。
  if coalesce(pg_catalog.current_setting('app.skip_access_log', true), '') = p_room::text then
    return;
  end if;

  -- ボードごと消しているときは、連鎖削除で呼ばれても書かない（親行がもう無い）
  if not exists (select 1 from public.rooms r where r.id = p_room) then
    return;
  end if;

  select m.display_name into v_name
    from public.room_members m
   where m.room_id = p_room and m.user_id = v_actor
   limit 1;

  insert into public.activities (room_id, actor_id, actor_name, action, target_type, target_label)
  values (p_room, v_actor, coalesce(nullif(p_actor_name, ''), v_name, ''),
          p_action, 'access', coalesce(p_label, ''));
end;
$$;

-- 参加者の参加・承認・見送り・権限変更・取り消し・退出。
-- 表示名やお気に入りの変更では何も残さない（履歴が埋まってしまうため）。
create or replace function public.tg_log_member_access()
returns trigger language plpgsql security definer
set search_path = '' as $$
declare
  v_label text;
begin
  -- 承認を待たずに入れた人（リンク公開・合言葉つき）は、ここでしか記録が残らない。
  -- 承認された人は status が変わるので、下の member_approved が拾う。
  -- 申し込んだだけの人（pending）は、まだ参加していないので残さない。
  -- 作った人の行（owner）は、ボードを作ったことそのものなので残さない。
  if TG_OP = 'INSERT' then
    if NEW.status = 'approved' and NEW.role <> 'owner' then
      perform public.log_access(NEW.room_id, 'member_joined',
                                coalesce(nullif(NEW.display_name, ''), '名前なし'));
    end if;
    return null;
  end if;

  if TG_OP = 'DELETE' then
    v_label := coalesce(nullif(OLD.display_name, ''), '名前なし');
    -- 自分の行を消したなら退出、そうでなければオーナーが外した
    if OLD.user_id = auth.uid() then
      perform public.log_access(OLD.room_id, 'member_left', v_label, v_label);
    else
      perform public.log_access(OLD.room_id, 'member_removed', v_label);
    end if;
    return null;
  end if;

  v_label := coalesce(nullif(NEW.display_name, ''), '名前なし');

  if NEW.status is distinct from OLD.status then
    if NEW.status = 'approved' then
      perform public.log_access(NEW.room_id, 'member_approved', v_label);
    elsif NEW.status = 'rejected' then
      -- 一度入れた人を落としたのは「取り消し」。申請を断ったのとは意味が違う
      perform public.log_access(
        NEW.room_id,
        case when OLD.status = 'approved' then 'member_removed' else 'member_rejected' end,
        v_label);
    end if;
  end if;

  if NEW.can_edit is distinct from OLD.can_edit then
    perform public.log_access(
      NEW.room_id,
      case when NEW.can_edit then 'member_can_edit' else 'member_view_only' end,
      v_label);
  end if;

  return null;
end;
$$;

-- ボードの終了・再開、共有リンクの作り直し、入り方と参加条件の変更。
create or replace function public.tg_log_room_access()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if NEW.archived is distinct from OLD.archived then
    perform public.log_access(
      NEW.id, case when NEW.archived then 'board_closed' else 'board_reopened' end);
  end if;

  if NEW.slug is distinct from OLD.slug then
    perform public.log_access(NEW.id, 'link_rotated');
  end if;

  if NEW.visibility is distinct from OLD.visibility then
    perform public.log_access(NEW.id, 'access_mode',
      case
        when NEW.visibility = 'public' then 'リンク公開'
        when exists (
          select 1 from public.room_secrets s
           where s.room_id = NEW.id and s.pin_hash is not null
        ) then '合言葉つき'
        else '承認制'
      end);
  end if;

  if NEW.join_closed is distinct from OLD.join_closed then
    perform public.log_access(NEW.id, 'join_settings',
      case when NEW.join_closed then '新しい参加の受付を止めました'
           else '新しい参加の受付を再開しました' end);
  end if;

  if NEW.join_expires_at is distinct from OLD.join_expires_at then
    perform public.log_access(NEW.id, 'join_settings',
      case when NEW.join_expires_at is null then '参加期限をなくしました'
           else '参加期限を決めました' end);
  end if;

  if NEW.max_members is distinct from OLD.max_members then
    perform public.log_access(NEW.id, 'join_settings',
      case when NEW.max_members is null then '人数の上限をなくしました'
           else '人数の上限を ' || NEW.max_members || ' 人にしました' end);
  end if;

  return null;
end;
$$;

drop trigger if exists room_members_access_log on public.room_members;
create trigger room_members_access_log
  after insert or update or delete on public.room_members
  for each row execute function public.tg_log_member_access();

drop trigger if exists rooms_access_log on public.rooms;
create trigger rooms_access_log
  after update on public.rooms
  for each row execute function public.tg_log_room_access();

-- 旧データの引き継ぎ（1 回だけ。流し直しても増えない）。
--
-- 承認・見送りの表示は room_members.decided_at から activities へ移した。
-- decided_at は「最後の 1 回」しか持たず、誰が決めたのかも残っていないので、
-- 履歴としては activities のほうが正しい。ただし移す前の記録が画面から消えると
-- 「履歴が飛んだ」と見えるため、分かる範囲だけを写しておく。
-- 誰が決めたかは復元できないので actor は空にする（画面では
-- 「◯◯ の参加が承認されました」と、決めた人を出さない形で並ぶ）。
insert into public.activities
       (room_id, actor_id, actor_name, action, target_type, target_label, created_at)
select m.room_id,
       null,
       '',
       case when m.status = 'approved' then 'member_approved' else 'member_rejected' end,
       'access',
       coalesce(nullif(m.display_name, ''), '名前なし'),
       m.decided_at
  from public.room_members m
 where m.decided_at is not null
   and m.role <> 'owner'
   and m.status in ('approved', 'rejected')
   and not exists (
     select 1 from public.activities a
      where a.room_id = m.room_id
        and a.target_type = 'access'
        and a.created_at = m.decided_at
   );


-- ---- 書き換えてはいけない列を守る ----------------------------------------
--
-- RLS の UPDATE ポリシーは「その行を書き換えてよいか」しか見ない。
-- room_id を書き換えると「自分のボードの行を他人のボードへ移す」ことが、
-- author_id / user_id を書き換えると「他人が書いたことにする」「他人の票にする」ことが
-- できてしまう。TG_ARGV に並べた列は UPDATE で変えられないようにする。
-- errcode を insufficient_privilege にしているのは、RLS で弾かれたときと同じ扱いに
-- するため（画面側は「権限がありません」として処理できる）。
create or replace function public.tg_freeze_columns()
returns trigger language plpgsql as $$
declare
  v_old jsonb;
  v_new jsonb;
  c     text;
begin
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  foreach c in array TG_ARGV loop
    if (v_new -> c) is distinct from (v_old -> c) then
      raise exception '% は変更できません', c using errcode = 'insufficient_privilege';
    end if;
  end loop;
  return NEW;
end;
$$;

-- rooms.owner_id には付けない（claim_owner が正当に書き換える）。
do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- author_id を持つテーブル
      ('notes',           'author_id'), ('strokes',        'author_id'),
      ('events',          'author_id'), ('event_overrides','author_id'),
      ('todos',           'author_id'), ('images',         'author_id'),
      ('connectors',      'author_id'), ('frames',         'author_id'),
      ('attachments',     'author_id'), ('polls',          'author_id'),
      ('calendar_feeds',  'author_id'), ('snapshots',      'author_id'),
      ('comments',        'author_id'),
      -- user_id を持つテーブル
      ('room_members',    'user_id'),   ('note_votes',     'user_id'),
      ('note_reactions',  'user_id'),   ('poll_votes',     'user_id'),
      ('notifications',   'user_id'),
      -- 候補日は「どの投票のものか」を動かせない
      ('poll_options',    'poll_id')
    ) as v(tbl, col)
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_freeze', r.tbl);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.tg_freeze_columns(%L, %L)',
      r.tbl || '_freeze', r.tbl, 'room_id', r.col);
  end loop;
end;
$$;

-- 追加で凍らせる列。
--
-- INSERT のときはポリシーで確かめているのに、UPDATE では誰も見ていない列がある。
--
--   storage_path — 差し替えると、古い実体が purge_queue に積まれないまま残る。
--                  掃除の予約は images / attachments の DELETE でしか動かない。
--                  ボードの複製は行を新しく INSERT するので、ここは困らない。
--   通知の中身   — 受け取った人が自分あての通知を書き換えられる。読んだ印（read）
--                  以外は送った側のものなので、動かさない。
drop trigger if exists images_freeze_path on public.images;
create trigger images_freeze_path
  before update on public.images
  for each row execute function public.tg_freeze_columns('storage_path');

drop trigger if exists attachments_freeze_path on public.attachments;
create trigger attachments_freeze_path
  before update on public.attachments
  for each row execute function public.tg_freeze_columns('storage_path');

drop trigger if exists notifications_freeze_body on public.notifications;
create trigger notifications_freeze_body
  before update on public.notifications
  for each row execute function public.tg_freeze_columns(
    'kind', 'body', 'link_tab', 'link_id', 'actor_name');

-- ---- 件数の上限 ------------------------------------------------------------
--
-- 1 ボードに入れられる件数の天井。無料枠の DB を 1 人に埋め尽くされないための保険で、
-- ふつうに使っていて届く数ではない。
-- security definer なのは、count が RLS を通らずに全行を数えられるようにするため。
create or replace function public.tg_limit_rows_per_room()
returns trigger language plpgsql security definer
set search_path = '' as $$
declare
  v_max   integer;
  v_count bigint;
begin
  v_max := TG_ARGV[0]::integer;
  execute format('select count(*) from public.%I where room_id = $1', TG_TABLE_NAME)
     into v_count using NEW.room_id;
  if v_count >= v_max then
    raise exception '% はボードあたり % 件までです', TG_ARGV[1], v_max
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('notes',           2000, '付箋'),
      -- strokes.points の上限（120000 文字）と掛け合わせた最悪ケースが
      -- 無料枠を食い潰さない値にしている。手描き 2500 本は通常利用では届かない。
      ('strokes',         2500, '手描き'),
      ('images',           300, '画像'),
      ('attachments',      200, '添付ファイル'),
      ('events',          3000, '予定'),
      ('event_overrides', 5000, '予定の例外'),
      ('todos',           3000, 'やること'),
      ('comments',        5000, 'コメント'),
      ('connectors',      2000, '線'),
      ('frames',           300, 'フレーム'),
      ('polls',            100, '日程調整'),
      ('poll_options',    2000, '候補日'),
      ('calendar_feeds',    20, '外部カレンダー'),
      -- payload は 1 件 3MB まで許している（大きなボードを丸ごと控えるため下げられない）。
      -- そのぶん件数を絞って、1 ボードあたりの最悪ケースを抑える。
      ('snapshots',         12, '保存した状態')
    ) as v(tbl, max_rows, label)
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_limit_rows', r.tbl);
    execute format(
      'create trigger %I before insert on public.%I
         for each row execute function public.tg_limit_rows_per_room(%L, %L)',
      r.tbl || '_limit_rows', r.tbl, r.max_rows, r.label);
  end loop;
end;
$$;

-- 1 人が持てるボードの数。
--
-- 「作る」だけでなく「受け取る」にも効かせる。オーナー復帰（claim_owner）は
-- rooms.owner_id を付け替えるので、INSERT だけを見ていると、作れないぶんを
-- 受け取りで回避して何個でも持ててしまう。
-- 同じ人が持ち直すだけ（owner_id が動かない UPDATE）では数えない。
create or replace function public.tg_limit_rooms_per_user()
returns trigger language plpgsql security definer
set search_path = '' as $$
declare
  v_count bigint;
begin
  if TG_OP = 'UPDATE' and NEW.owner_id is not distinct from OLD.owner_id then
    return NEW;
  end if;

  -- BEFORE なので、この行はまだ数に入っていない（付け替えなら、まだ前の人のもの）
  select count(*) into v_count from public.rooms where owner_id = NEW.owner_id;
  if v_count >= 50 then
    raise exception 'ボードは 1 人 50 個までです' using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists rooms_limit_per_user on public.rooms;
create trigger rooms_limit_per_user
  before insert or update of owner_id on public.rooms
  for each row execute function public.tg_limit_rooms_per_user();

-- ---- やることの担当者 -------------------------------------------------------
--
-- 担当者はそのボードの関係者（オーナーか room_members にいる人）だけ。
-- 無関係な人の id を入れられると、その人の「自分の担当」にボードの中身が漏れる。
--
-- UPDATE（画面で担当を選び直す操作）では例外にする。
-- INSERT では担当を外して通す。ボードの複製や「保存した状態」からの復元は、
-- 元の担当者がもう参加していなくても行を丸ごと入れ直すので、そこで落とすと
-- 複製・復元そのものが途中で止まってしまう（復元は消してから入れ直す作りなので、
-- 途中で止まると中身が消えたままになる）。
create or replace function public.tg_guard_todo_assignee()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if NEW.assignee_id is not null
     and not public.is_room_participant(NEW.room_id, NEW.assignee_id) then
    if TG_OP = 'INSERT' then
      NEW.assignee_id   := null;
      NEW.assignee_name := '';
    else
      raise exception '担当者はこのボードの参加者から選んでください'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists todos_guard_assignee on public.todos;
create trigger todos_guard_assignee
  before insert or update of assignee_id on public.todos
  for each row execute function public.tg_guard_todo_assignee();

-- ---- Storage の実体の掃除を予約する ----------------------------------------
--
-- SQL から storage.objects を直接 delete しない。あれは storage-api の台帳であって、
-- 行を消しても S3 の実体は残る（容量を食い続けるうえ、台帳と実体がずれる）。
-- 実体は Storage API を通してしか消せないので、ここでは purge_queue に積むだけにして、
-- purge-storage Edge Function（毎時）に消してもらう。
--
-- ボードごと消したときは、連鎖削除で画像・添付の行も 1 つずつここを通るが、
-- その場合は rooms 側のトリガーがフォルダ丸ごと（prefix）を積むので、1 件ずつは積まない。
create or replace function public.tg_enqueue_purge()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if coalesce(OLD.storage_path, '') = '' then
    return null;
  end if;
  if not exists (select 1 from public.rooms r where r.id = OLD.room_id) then
    return null;                                 -- ボードごと消えている（prefix で消す）
  end if;
  insert into public.purge_queue (bucket, kind, path)
  values (TG_ARGV[0], 'object', OLD.storage_path);
  return null;
end;
$$;

drop trigger if exists images_enqueue_purge on public.images;
create trigger images_enqueue_purge
  after delete on public.images
  for each row execute function public.tg_enqueue_purge('board-images');

drop trigger if exists attachments_enqueue_purge on public.attachments;
create trigger attachments_enqueue_purge
  after delete on public.attachments
  for each row execute function public.tg_enqueue_purge('board-files');

-- ボードを消すときは、両方のバケットの '<room_id>/' 以下を丸ごと予約する。
-- before delete なのは、after だと連鎖削除のあとで room_id しか残らないため
-- （それでも書けるが、順番が分かりやすいので先に積む）。
create or replace function public.tg_enqueue_purge_room()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  insert into public.purge_queue (bucket, kind, path) values
    ('board-images', 'prefix', OLD.id::text || '/'),
    ('board-files',  'prefix', OLD.id::text || '/');
  return OLD;
end;
$$;

drop trigger if exists rooms_enqueue_purge on public.rooms;
create trigger rooms_enqueue_purge
  before delete on public.rooms
  for each row execute function public.tg_enqueue_purge_room();

-- ---- ブラウザ側のエラーの流量 ---------------------------------------------
--
-- 1 人あたり毎分 10 件まで。超えた分は例外にせず黙って捨てる
-- （エラー報告が失敗してさらにエラー報告を呼ぶ、という連鎖を作らない）。
create or replace function public.tg_throttle_client_errors()
returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  if (select count(*) from public.client_errors e
       where e.user_id = NEW.user_id
         and e.created_at > now() - interval '1 minute') >= 10 then
    return null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists client_errors_throttle on public.client_errors;
create trigger client_errors_throttle
  before insert on public.client_errors
  for each row execute function public.tg_throttle_client_errors();


-- =============================================================================
--  4. RLS ポリシー
-- =============================================================================

alter table public.rooms         enable row level security;
alter table public.room_secrets  enable row level security;
alter table public.room_members  enable row level security;
alter table public.notes         enable row level security;
alter table public.strokes       enable row level security;
alter table public.events        enable row level security;
alter table public.event_overrides enable row level security;
alter table public.todos         enable row level security;
alter table public.images        enable row level security;
alter table public.comments      enable row level security;
alter table public.note_votes    enable row level security;
alter table public.activities    enable row level security;
alter table public.connectors    enable row level security;
alter table public.frames        enable row level security;
alter table public.attachments   enable row level security;
alter table public.note_reactions enable row level security;
alter table public.polls         enable row level security;
alter table public.poll_options  enable row level security;
alter table public.poll_votes    enable row level security;
alter table public.calendar_feeds enable row level security;
alter table public.notifications enable row level security;
alter table public.snapshots     enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminder_sends     enable row level security;  -- ポリシー無し = 誰も触れない
alter table public.access_attempts    enable row level security;  -- 同上（RPC の内側だけ）
alter table public.purge_queue        enable row level security;  -- 同上（トリガーと Edge Function だけ）
alter table public.client_errors      enable row level security;

-- ---- rooms -------------------------------------------------------------
-- リンク公開でも、参加登録していない人には行そのものを見せない。
-- 名前など「入る前に要るもの」は get_room_preview（security definer）が返す。
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated
  using (
    owner_id = auth.uid()
    or public.my_membership_status(id) is not null
  );

drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (owner_id = auth.uid());

-- ---- room_secrets ------------------------------------------------------
-- 復帰トークンはオーナーだけが読める。書き込みはトリガー（security definer）経由のみ。
drop policy if exists room_secrets_select on public.room_secrets;
create policy room_secrets_select on public.room_secrets for select to authenticated
  using (public.is_room_owner(room_id));

-- ---- room_members ------------------------------------------------------
-- 自分の行はいつでも見える（承認待ち・取り消し済みでも、自分の状態は分かる）。
-- 参加者名簿（承認済みの行）は、オーナーと承認済みの参加者だけが見える。
-- 参加登録していない人には、リンク公開のボードでも誰がいるか見えない。
drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members for select to authenticated
  using (
    user_id = auth.uid()                                   -- 自分の行
    or public.is_room_owner(room_id)                       -- オーナーは申請含め全部見える
    or (status = 'approved' and public.can_access_room(room_id))  -- 参加者名簿
  );

-- 直接 INSERT できるのは「作成者が自分をオーナーとして登録する」ときだけ。
-- 参加・申請は request_access（security definer）経由のみ。
-- 直接 INSERT を許すと、受付停止・参加期限・人数上限・合言葉の判定をすり抜けて
-- 参加者になれてしまう。
drop policy if exists room_members_insert on public.room_members;
create policy room_members_insert on public.room_members for insert to authenticated
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and status = 'approved'
    and public.is_room_owner(room_id)
  );

-- 承認・却下はオーナーのみ。参加者は自分の表示名だけ更新できる
-- （status / role の書き換えは tg_guard_member_update が握りつぶす）。
drop policy if exists room_members_update on public.room_members;
create policy room_members_update on public.room_members for update to authenticated
  using (public.is_room_owner(room_id) or user_id = auth.uid())
  with check (public.is_room_owner(room_id) or user_id = auth.uid());

-- 自分で消せるのは「いま入っている人が抜ける」ときだけ（ボードの設定の「退出する」）。
-- 却下された人・承認待ちの人まで消せると、行が無い状態から request_access を
-- やり直せてしまい、リンク公開のボードではその場で承認されて
-- 「アクセスを取り消す」が帳消しになる。却下された行を片付けるのはオーナーの役目。
--
-- ここはポリシーだけで守っている。BEFORE DELETE のトリガーで二重にすることも考えたが、
-- ボードごと消したときの連鎖削除（rooms -> room_members）と delete_my_account は
-- この道を正当に通る。しかも連鎖の途中では親の rooms がもう無いので、トリガーからは
-- 「誰が何のために消しているか」を見分けられない。代わりに rls.test.sql で固定する。
drop policy if exists room_members_delete on public.room_members;
create policy room_members_delete on public.room_members for delete to authenticated
  using (
    public.is_room_owner(room_id)
    or (user_id = auth.uid() and status = 'approved')
  );

-- ---- ルームの中身（共通ルール）------------------------------------------
-- 読むのは参加できる人なら誰でも。書き換えは編集権限のある人だけ。
-- 作成時は author_id = 自分 を強制する。
do $$
declare t text;
begin
  foreach t in array array[
    'notes', 'strokes', 'events', 'event_overrides', 'todos', 'images',
    'connectors', 'frames', 'attachments', 'polls', 'calendar_feeds', 'snapshots'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.can_access_room(room_id))',
      t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.can_edit_room(room_id) and author_id = auth.uid())',
      t || '_insert', t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.can_edit_room(room_id)) with check (public.can_edit_room(room_id))',
      t || '_update', t);

    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.can_edit_room(room_id))',
      t || '_delete', t);
  end loop;
end;
$$;

-- ---- コメント ----------------------------------------------------------
-- 「閲覧のみ」の人でもコメントは書ける（議論には参加できる）。
-- ただし他人の発言は書き換えられない。
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated
  using (public.can_access_room(room_id));

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check (
    public.can_access_room(room_id)
    and public.room_is_open(room_id)                       -- 終了したボードには書き込めない
    and author_id = auth.uid()
  );

-- 書き換え・取り消しも「書き込み」なので room_is_open を見る。
-- INSERT だけが見ていると、終了したボードで自分の発言だけは直せてしまい、
-- 「終了したボードでは誰も書けない」が嘘になる。
-- 取り消された人は comments_select を通れないので、ここには辿り着かない。
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update to authenticated
  using (author_id = auth.uid() and public.room_is_open(room_id))
  with check (author_id = auth.uid() and public.room_is_open(room_id));

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated
  using (
    (author_id = auth.uid() or public.is_room_owner(room_id))
    and public.room_is_open(room_id)
  );

-- ---- 付箋への投票 ------------------------------------------------------
-- コメントと同じく「閲覧のみ」の人も投票できる。自分の票だけ操作可能。
drop policy if exists note_votes_select on public.note_votes;
create policy note_votes_select on public.note_votes for select to authenticated
  using (public.can_access_room(room_id));

drop policy if exists note_votes_insert on public.note_votes;
create policy note_votes_insert on public.note_votes for insert to authenticated
  with check (
    public.can_access_room(room_id)
    and public.room_is_open(room_id)
    and user_id = auth.uid()
  );

-- 取り下げも書き込みなので、INSERT と同じく room_is_open を見る
drop policy if exists note_votes_delete on public.note_votes;
create policy note_votes_delete on public.note_votes for delete to authenticated
  using (user_id = auth.uid() and public.room_is_open(room_id));

-- ---- 日程調整の候補日 --------------------------------------------------
-- 候補日そのものは投票欄の一部なので、編集権限のある人が作る。
drop policy if exists poll_options_select on public.poll_options;
create policy poll_options_select on public.poll_options for select to authenticated
  using (public.can_access_room(room_id));

drop policy if exists poll_options_write on public.poll_options;
create policy poll_options_write on public.poll_options for all to authenticated
  using (public.can_edit_room(room_id))
  with check (public.can_edit_room(room_id));

-- ---- 投票・リアクション ------------------------------------------------
-- 「閲覧のみ」の人も参加できる。自分の分だけ操作可能。
do $$
declare t text;
begin
  foreach t in array array['poll_votes', 'note_reactions'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.can_access_room(room_id))',
      t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.can_access_room(room_id) and public.room_is_open(room_id) and user_id = auth.uid())',
      t || '_insert', t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.room_is_open(room_id) and user_id = auth.uid()) with check (public.room_is_open(room_id) and user_id = auth.uid())',
      t || '_update', t);

    -- 取り下げも書き込み。INSERT と同じく room_is_open を見る
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.room_is_open(room_id) and user_id = auth.uid())',
      t || '_delete', t);
  end loop;
end;
$$;

-- ---- 通知 --------------------------------------------------------------
-- 宛先本人だけが読める。作成は「同じボードにいる人」から「そのボードの関係者」あてに限る。
-- 宛先を検証しないと、ボードと無関係な人（推測した uuid）に通知を送りつけられる。
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

-- room_is_open も見る。ここだけ抜けていると、終了したボード（他の書き込みは全部止まる）
-- にも通知を積めてしまい、プッシュ通知として端末に届いてしまう。
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert to authenticated
  with check (
    public.can_access_room(room_id)
    and public.room_is_open(room_id)
    and public.is_room_participant(room_id, user_id)
  );

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- ---- 変更履歴 ----------------------------------------------------------
-- 読むだけ。書き込みはトリガー（security definer）経由のみで、
-- クライアントからの INSERT / UPDATE / DELETE はポリシーが無いので全て拒否される。
drop policy if exists activities_select on public.activities;
create policy activities_select on public.activities for select to authenticated
  using (public.can_access_room(room_id));

-- ---- プッシュ通知の送信先 ----------------------------------------------
drop policy if exists push_subscriptions_all on public.push_subscriptions;
create policy push_subscriptions_all on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---- ブラウザ側のエラー ------------------------------------------------
-- 自分の分を書けるだけ。読む・直す・消すのポリシーは無い（他人のスタックを覗けない）。
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors for insert to authenticated
  with check (user_id = auth.uid());


-- =============================================================================
--  5. RPC
--     非公開ルームは URL を知っているだけの人からは SELECT できないので、
--     「名前だけ見せる」「参加申請する」処理を security definer 関数で提供する。
-- =============================================================================

-- ルームの概要だけを返す（中身は一切返さない）
-- 戻り値の列を増やしたので、古い定義が残っていても作り直せるよう drop してから作る。
--
-- 合言葉そのものは返さない。「要るかどうか」だけを boolean で返す。
drop function if exists public.get_room_preview(text);
create function public.get_room_preview(p_slug text)
returns table (
  id           uuid,
  slug         text,
  name         text,
  visibility   text,
  owner_name   text,
  is_owner     boolean,
  my_status    text,
  can_edit     boolean,
  -- 終了したボード。読めるが書き込めない
  archived     boolean,
  -- 合言葉が要るかどうかだけ。合言葉そのものは返さない
  needs_pin    boolean,
  -- 入れない理由。空文字なら入れる
  join_blocked text
)
language sql security definer stable
set search_path = '' as $$
  select r.id,
         r.slug,
         r.name,
         r.visibility,
         r.owner_name,
         (r.owner_id = auth.uid())              as is_owner,
         public.my_membership_status(r.id)      as my_status,
         public.can_edit_room(r.id)             as can_edit,
         r.archived                             as archived,
         (s.pin_hash is not null)               as needs_pin,
         case
           -- すでに参加している人には、あとから足した条件を出さない
           when public.my_membership_status(r.id) = 'approved' then ''
           when r.join_closed then '参加の受付を止めています'
           when r.join_expires_at is not null and r.join_expires_at < now()
             then '新しく参加できる期限を過ぎています'
           when r.max_members is not null
                and (select count(*) from public.room_members m
                      where m.room_id = r.id and m.status = 'approved') >= r.max_members
             then '参加できる人数の上限に達しています'
           else ''
         end                                    as join_blocked
    from public.rooms r
    left join public.room_secrets s on s.room_id = r.id
   where r.slug = p_slug;
$$;

-- 合言葉・オーナー復帰トークンの総当たり対策。
--
-- 本人（auth.uid()）は 10 分に 5 回まで、ボード全体では 10 分に 30 回まで失敗できる。
-- ボード全体の枠があるのは、匿名サインインは ID を取り直せるので本人の枠だけでは
-- 意味が薄いため。どちらも RPC の内側からしか呼べない（実行権限は下で取り上げる）。
create or replace function public.check_access_attempts(p_room uuid, p_kind text)
returns void
language plpgsql security definer
set search_path = '' as $$
declare
  v_mine  integer;
  v_total bigint;
begin
  select a.failed_count into v_mine
    from public.access_attempts a
   where a.room_id = p_room and a.user_id = auth.uid() and a.kind = p_kind
     and a.last_failed_at > now() - interval '10 minutes';

  if coalesce(v_mine, 0) >= 5 then
    raise exception '間違いが続いたため、10 分ほど待ってからやり直してください';
  end if;

  -- ボード全体の枠。匿名サインインは何度でも取り直せるので、本人単位の 5 回だけでは
  -- 「新しい ID を作っては 5 回試す」を止められない。そのための第 2 の壁。
  --
  -- ただしこの枠は「正しい合言葉を知っている人まで巻き込む」性質がある。
  -- わざと失敗を積み上げれば、そのボードに誰も入れなくできてしまう。
  -- だから対象は合言葉（kind='pin'）だけに限り、しきい値も上げている。
  --
  -- オーナー復帰（kind='owner'）は絶対に全体の枠に入れない。
  -- ここを巻き込めると、オーナー復帰リンクを恒久的に使えなくできてしまう
  -- （復帰リンクは本人単位の 5 回と、推測できない 32 文字のトークンで守る）。
  --
  -- 機械的な量産そのものを止めたいときは CAPTCHA を有効にする
  -- （docs/SETUP.md「CAPTCHA（任意）」。VITE_TURNSTILE_SITE_KEY）。
  if p_kind = 'pin' then
    select coalesce(sum(a.failed_count), 0) into v_total
      from public.access_attempts a
     where a.room_id = p_room and a.kind = p_kind
       and a.last_failed_at > now() - interval '10 minutes';

    if v_total >= 200 then
      raise exception 'このボードへの入力が集中しています。しばらく待ってからやり直してください';
    end if;
  end if;
end;
$$;

-- 成功したら行ごと消す。失敗は数を増やす（10 分より前の失敗は数え直す）。
create or replace function public.record_access_attempt(p_room uuid, p_kind text, p_ok boolean)
returns void
language plpgsql security definer
set search_path = '' as $$
begin
  if p_ok then
    delete from public.access_attempts a
     where a.room_id = p_room and a.user_id = auth.uid() and a.kind = p_kind;
    return;
  end if;

  insert into public.access_attempts as a (room_id, user_id, kind, failed_count, last_failed_at)
  values (p_room, auth.uid(), p_kind, 1, now())
  on conflict (room_id, user_id, kind) do update
    set failed_count   = case when a.last_failed_at < now() - interval '10 minutes'
                              then 1 else a.failed_count + 1 end,
        last_failed_at = now();
end;
$$;

-- 参加申請（公開ルームならその場で承認済みメンバーになる）
--
-- 合言葉・参加期限・人数上限・受付停止の判定はここで行う。
-- クライアントの UI だけで止めても、RPC を直接叩かれれば入れてしまうため。
--
-- 合言葉が違うときは例外ではなく 'pin_mismatch' を返す。
-- 例外にするとトランザクションごと巻き戻り、直前に書いた失敗の記録まで消えてしまう
-- （＝何回間違えても数えられない）。画面側はこの戻り値を「合言葉が違います」に読み替える。
drop function if exists public.request_access(text, text, text);
create or replace function public.request_access(
  p_slug    text,
  p_name    text,
  p_message text default '',
  p_pin     text default ''
)
returns text
language plpgsql security definer
set search_path = '' as $$
declare
  v_room     public.rooms;
  v_member   public.room_members;
  v_existing boolean;
  v_reapply  boolean;
  v_status   text;
  v_hash     text;
  v_approved integer;
begin
  if auth.uid() is null then
    raise exception 'セッションがありません';
  end if;

  select * into v_room from public.rooms where slug = p_slug;
  if not found then
    raise exception 'ルームが見つかりません';
  end if;

  select * into v_member
    from public.room_members
   where room_id = v_room.id and user_id = auth.uid();
  v_existing := found;

  -- すでに参加している人は締め出さない。
  -- あとから合言葉や上限を足しても、いま中にいる人は入り直せる。
  if v_existing and v_member.status = 'approved' then
    update public.room_members
       set display_name = coalesce(nullif(p_name, ''), display_name)
     where id = v_member.id;
    return 'approved';
  end if;

  if v_room.join_closed then
    raise exception '参加の受付を止めています';
  end if;

  if v_room.join_expires_at is not null and v_room.join_expires_at < now() then
    raise exception '新しく参加できる期限を過ぎています';
  end if;

  if v_room.max_members is not null then
    select count(*) into v_approved
      from public.room_members
     where room_id = v_room.id and status = 'approved';

    if v_approved >= v_room.max_members then
      raise exception '参加できる人数の上限に達しています';
    end if;
  end if;

  select s.pin_hash into v_hash
    from public.room_secrets s
   where s.room_id = v_room.id;

  if v_hash is not null then
    perform public.check_access_attempts(v_room.id, 'pin');

    if extensions.crypt(btrim(coalesce(p_pin, '')), v_hash) <> v_hash then
      perform public.record_access_attempt(v_room.id, 'pin', false);
      return 'pin_mismatch';                     -- 例外にしない（上のコメント参照）
    end if;

    perform public.record_access_attempt(v_room.id, 'pin', true);
  end if;

  if v_existing then
    -- 既に申請済み。却下されていた場合のみ再申請として pending に戻す。
    v_reapply := v_member.status = 'rejected';
    v_status  := case when v_reapply then 'pending' else v_member.status end;

    -- 却下 -> 承認待ちに戻せるのは、ここまでの判定を通ったときだけ。
    -- tg_guard_member_update は、この目印が指す行の更新しか通さない（読んだら消える）。
    if v_reapply then
      perform pg_catalog.set_config('app.reapply_member', v_member.id::text, true);
    end if;

    update public.room_members
       set display_name = coalesce(nullif(p_name, ''), display_name),
           message      = coalesce(nullif(p_message, ''), message),
           status       = v_status,
           -- 承認待ちに戻すなら「決めた日時」も無かったことにする。
           -- 新しい申し込みは必ず null なので、同じ状態を 2 通りで持たない
           decided_at   = case when v_reapply then null else decided_at end
     where id = v_member.id;

    -- 使われなかったときのために、目印は必ず落としておく
    perform pg_catalog.set_config('app.reapply_member', '', true);

    -- 申し込み直したこともオーナーに知らせる（新しい申し込みと同じ扱い）。
    -- 知らせが無いと、参加者パネルを開いていないオーナーは気づけない
    if v_reapply then
      insert into public.notifications (room_id, user_id, kind, body, link_tab)
      values (v_room.id, v_room.owner_id, 'join_request',
              coalesce(nullif(p_name, ''), '名前なし') || ' さんが参加を申し込みました',
              'board');
    end if;

    return v_status;
  end if;

  -- 合言葉が合っていれば、それが本人確認の代わりになるので承認は要らない。
  -- （合言葉つきのボードは非公開にしてある。公開のままでは RLS が誰でも通してしまう）
  v_status := case
    when v_room.visibility = 'public' then 'approved'
    when v_hash is not null then 'approved'
    else 'pending'
  end;

  insert into public.room_members (room_id, user_id, display_name, role, status, message)
  values (v_room.id, auth.uid(), p_name, 'member', v_status, p_message);

  -- 申請はオーナーに知らせる。ボードを開いていないと赤バッジには気づけない。
  if v_status = 'pending' then
    insert into public.notifications (room_id, user_id, kind, body, link_tab)
    values (v_room.id, v_room.owner_id, 'join_request',
            coalesce(nullif(p_name, ''), '名前なし') || ' さんが参加を申し込みました',
            'board');
  end if;

  return v_status;
end;
$$;

-- 共有リンクを作り直す。古い URL は使えなくなるが、
-- いまの参加者は room_members でつながっているので新しい URL から入れる。
create or replace function public.rotate_room_slug(p_room_id uuid)
returns text
language plpgsql security definer
set search_path = '' as $$
declare
  v_slug text;
begin
  if not public.is_room_owner(p_room_id) then
    raise exception 'オーナーだけが変更できます';
  end if;

  v_slug := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  update public.rooms set slug = v_slug where id = p_room_id;
  return v_slug;
end;
$$;

-- オーナー復帰リンクを作り直す（漏れたときのため）
create or replace function public.rotate_owner_token(p_room_id uuid)
returns text
language plpgsql security definer
set search_path = '' as $$
declare
  v_token text;
begin
  if not public.is_room_owner(p_room_id) then
    raise exception 'オーナーだけが変更できます';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  update public.room_secrets set recovery_token = v_token where room_id = p_room_id;
  perform public.log_access(p_room_id, 'owner_link_rotated');
  return v_token;
end;
$$;

-- カレンダーの購読 URL を発行する / 作り直す。
--
-- 返した 32 桁がそのまま URL に入る。作り直すと前の URL は使えなくなるので、
-- 相手のカレンダーからはこのボードの予定が消える。
create or replace function public.rotate_calendar_token(p_room_id uuid)
returns text
language plpgsql security definer
set search_path = '' as $$
declare
  v_token text;
begin
  if not public.is_room_owner(p_room_id) then
    raise exception 'オーナーだけが変更できます';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  update public.room_secrets
     set calendar_token = v_token, calendar_token_at = now()
   where room_id = p_room_id;
  perform public.log_access(p_room_id, 'calendar_link_rotated');
  return v_token;
end;
$$;

-- カレンダーの購読 URL を止める。以後、その URL は「見つかりません」になる。
create or replace function public.clear_calendar_token(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = '' as $$
begin
  if not public.is_room_owner(p_room_id) then
    raise exception 'オーナーだけが変更できます';
  end if;

  update public.room_secrets
     set calendar_token = null, calendar_token_at = null
   where room_id = p_room_id;
  perform public.log_access(p_room_id, 'calendar_link_cleared');
end;
$$;

-- 合言葉の設定。room_secrets は SELECT しかポリシーが無いので、ここから書く。
-- 平文は保存しない（bcrypt）。空文字を渡すと合言葉なしになる。
create or replace function public.set_join_pin(p_room_id uuid, p_pin text)
returns void
language plpgsql security definer
set search_path = '' as $$
declare
  v_pin text := btrim(coalesce(p_pin, ''));
begin
  if not public.is_room_owner(p_room_id) then
    raise exception 'オーナーだけが変更できます';
  end if;

  -- 短すぎる合言葉を許さない。ボード全体の試行回数の枠は「正しい合言葉を知っている人まで
  -- 巻き込む」ので緩くせざるを得ず（check_access_attempts を参照）、そのぶん
  -- 合言葉そのものが推測されにくい必要がある。1 文字の合言葉は総当たりで即座に破れる。
  if v_pin <> '' and length(v_pin) < 6 then
    raise exception '合言葉は 6 文字以上にしてください';
  end if;

  update public.room_secrets
     set pin_hash = case
                      when v_pin = '' then null
                      else extensions.crypt(v_pin, extensions.gen_salt('bf', 10))
                    end
   where room_id = p_room_id;

  perform public.log_access(
    p_room_id,
    case when v_pin <> '' then 'pin_set' else 'pin_cleared' end);
end;
$$;

-- いま参加している人を全員外す（リンクが知らない人に転送されてしまったとき用）。
--
-- リンク公開のままでは URL を知っている人がそのまま読めてしまうので、
-- 締め出すときは必ず承認制（visibility='private'）へ落とす。
-- 合言葉はそのまま残るので、合言葉つきのボードは合言葉つきのまま締まる。
create or replace function public.revoke_all_members(
  p_room_id     uuid,
  p_rotate_slug boolean default false
)
returns text                                   -- 現在の（作り直した場合は新しい）slug
language plpgsql security definer
set search_path = '' as $$
declare
  v_slug text;
  v_row  record;
begin
  if not public.is_room_owner(p_room_id) then
    raise exception 'オーナーだけが変更できます';
  end if;

  -- ここから先は 1 人ずつの履歴を残さない。まとめて「全員を外した」1 行にする。
  -- 効くのはこのボードだけ。トランザクションを抜ければ自動で戻る。
  -- 第 3 引数の true は「このトランザクションの中だけ」の意味。
  -- 接続が使い回されても、次の処理へは持ち越されない。
  perform pg_catalog.set_config('app.skip_access_log', p_room_id::text, true);

  update public.rooms set visibility = 'private' where id = p_room_id;

  -- 外した人に知らせる。黙って消えると「壊れた」と思われる。
  for v_row in
    select user_id from public.room_members
     where room_id = p_room_id and role <> 'owner' and status = 'approved'
  loop
    insert into public.notifications (room_id, user_id, kind, body, link_tab)
    values (p_room_id, v_row.user_id, 'join_decided',
            'このボードの参加が取り消されました', 'board');
  end loop;

  update public.room_members
     set status = 'rejected', decided_at = now()
   where room_id = p_room_id and role <> 'owner' and status = 'approved';

  if p_rotate_slug then
    v_slug := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    update public.rooms set slug = v_slug where id = p_room_id;
  else
    select slug into v_slug from public.rooms where id = p_room_id;
  end if;

  perform pg_catalog.set_config('app.skip_access_log', '', true);
  perform public.log_access(
    p_room_id, 'members_revoked_all',
    case when p_rotate_slug then '共有リンクも作り直しました' else '' end);

  return v_slug;
end;
$$;

-- 自分の利用をやめる（メールを結びつけた人向けの「データを消す」）。
--
-- 参加記録・通知・プッシュ購読を消す。p_delete_owned が真なら、自分が作った
-- ボードも消す（他の人が書いたものも一緒に消えるので、呼ぶ側で必ず確認を取ること）。
-- 匿名ユーザー自身は auth スキーマにいるため、ここでは消せない。
create or replace function public.delete_my_account(p_delete_owned boolean default false)
returns void
language plpgsql security definer
set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'セッションがありません';
  end if;

  if p_delete_owned then
    -- rooms を消せば、中身は on delete cascade で一緒に消える
    delete from public.rooms where owner_id = auth.uid();
  end if;

  delete from public.room_members      where user_id = auth.uid();
  delete from public.notifications     where user_id = auth.uid();
  delete from public.push_subscriptions where user_id = auth.uid();
  delete from public.client_errors     where user_id = auth.uid();

  -- access_attempts はここでは消さない。
  -- 合言葉やオーナー復帰の失敗回数はボードを守るための台帳で、本人の持ち物ではない。
  -- 消せると、止められた人が退会してそのまま総当たりを続けられる
  -- （当てようとしている人はまだ参加者ですらないので、退会に払う代償が無い）。
  -- 記録は check_access_attempts の窓（10 分）を過ぎれば自然に効かなくなる。
end;
$$;

-- オーナー復帰（別ブラウザに乗り換えたとき用）
--
-- トークンは 32 桁の乱数なので総当たりは現実的ではないが、
-- 合言葉と同じ試行制限をかけておく（間違いが続いたら 10 分待ち）。
drop function if exists public.claim_owner(text, text);
create or replace function public.claim_owner(p_slug text, p_token text, p_name text default '')
returns boolean
language plpgsql security definer
set search_path = '' as $$
declare
  v_room  public.rooms;
  v_token text;
begin
  if auth.uid() is null then
    return false;
  end if;

  select r.* into v_room from public.rooms r where r.slug = p_slug;
  if not found then
    return false;
  end if;

  perform public.check_access_attempts(v_room.id, 'owner');

  select s.recovery_token into v_token
    from public.room_secrets s
   where s.room_id = v_room.id;

  if v_token is null or v_token <> coalesce(p_token, '') then
    perform public.record_access_attempt(v_room.id, 'owner', false);
    return false;
  end if;

  perform public.record_access_attempt(v_room.id, 'owner', true);

  -- 使った復帰リンクは、その場で作り直す。
  -- 使い捨てにしないと、一度漏れたリンクは何度でも使え、しかも権限を奪われた側は
  -- もう room_secrets を読めないので、自分では作り直せない。
  update public.room_secrets
     set recovery_token = replace(gen_random_uuid()::text, '-', '')
   where room_id = v_room.id;

  update public.rooms set owner_id = auth.uid() where id = v_room.id;

  update public.room_members
     set role = 'member'
   where room_id = v_room.id and role = 'owner' and user_id <> auth.uid();

  insert into public.room_members (room_id, user_id, display_name, role, status)
  values (v_room.id, auth.uid(), coalesce(p_name, ''), 'owner', 'approved')
  on conflict (room_id, user_id)
  do update set role         = 'owner',
                status       = 'approved',
                -- 名前を渡されたときだけ上書きする（既に入っている名前を消さない）
                display_name = coalesce(nullif(p_name, ''), room_members.display_name);

  -- rooms 側の「作成者」表示も新しいオーナーに合わせる
  update public.rooms
     set owner_name = coalesce(nullif(p_name, ''), owner_name)
   where id = v_room.id;

  return true;
end;
$$;

-- ---- 保存した状態から戻す --------------------------------------------------
--
-- 以前は画面側から 8 テーブルぶんの delete / insert を並べていた。ここに移した理由:
--
--  1. 控えたときの「作った人の名前」を残すため。
--     author_name はなりすまし防止のトリガーが今の表示名で上書きするので、
--     復元中だけそれを止める必要がある。PostgREST は 1 リクエスト = 1 トランザクション
--     なので、この抑止は「復元そのものを 1 つの関数に閉じる」ことでしか成立しない。
--
--  2. ボードの中身を全部消して置き換える操作なので、オーナーだけに絞るため。
--     以前は編集できる人なら誰でも実行でき、ゴミ箱の 30 日猶予も飛ばして消えていた。
--
-- payload は控えた時点の行をそのまま持っているが、クライアントが作った JSON なので
-- そのまま信じない。security definer は RLS を素通りするため、room_id / author_id を
-- 言い値のまま入れると「別のボードへ行を注入する」「他人が書いたことにする」経路に
-- なってしまう。この 2 列だけは必ず上書きする（以前の画面側の実装と同じ扱い）。
create or replace function public.restore_snapshot(p_snapshot_id uuid)
returns void
language plpgsql security definer
set search_path = '' as $$
declare
  v_room    uuid;
  v_payload jsonb;
  v_rows    jsonb;
  v_cols    text;
  t         text;
begin
  select s.room_id, s.payload into v_room, v_payload
    from public.snapshots s where s.id = p_snapshot_id;

  if v_room is null then
    raise exception '保存した状態が見つかりません';
  end if;
  if not public.is_room_owner(v_room) then
    raise exception 'ボードを作った人だけが戻せます';
  end if;
  if not public.room_is_open(v_room) then
    raise exception '終了したボードには書き込めません';
  end if;

  perform pg_catalog.set_config('app.restoring_snapshot', v_room::text, true);

  -- 線は付箋を、「この回だけ」は予定を指すので、親を入れ直したあとに入れる
  foreach t in array array[
    'notes', 'strokes', 'connectors', 'frames',
    'events', 'event_overrides', 'todos', 'images'
  ] loop
    execute format('delete from public.%I where room_id = $1', t) using v_room;

    select jsonb_agg(e || jsonb_build_object('room_id', v_room, 'author_id', auth.uid()))
      into v_rows
      from jsonb_array_elements(coalesce(v_payload -> t, '[]'::jsonb)) e;

    if v_rows is null then
      continue;
    end if;

    -- 控えた時点に無かった列は触らない（今の既定値が入る）。
    -- 逆に、そのあと消えた列が payload に残っていても無視する。
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into v_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = t
       and exists (select 1 from jsonb_array_elements(v_rows) e where e ? c.column_name);

    if v_cols is null then
      continue;
    end if;

    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)',
      t, v_cols, v_cols, t) using v_rows;
  end loop;

  perform pg_catalog.set_config('app.restoring_snapshot', '', true);
end;
$$;

grant execute on function public.get_room_preview(text)            to authenticated;
grant execute on function public.request_access(text, text, text, text) to authenticated;
grant execute on function public.rotate_room_slug(uuid)            to authenticated;
grant execute on function public.rotate_owner_token(uuid)          to authenticated;
grant execute on function public.set_join_pin(uuid, text)          to authenticated;
grant execute on function public.rotate_calendar_token(uuid)       to authenticated;
grant execute on function public.clear_calendar_token(uuid)        to authenticated;
grant execute on function public.claim_owner(text, text, text)     to authenticated;
grant execute on function public.revoke_all_members(uuid, boolean) to authenticated;
grant execute on function public.delete_my_account(boolean)        to authenticated;
grant execute on function public.restore_snapshot(uuid)            to authenticated;

-- anon（セッションなし）からは何も呼べないようにする。
-- 画面は必ず匿名サインインを済ませてから RPC を呼ぶので、anon で呼ぶ経路は無い。
-- 開けておくと、セッションを作らずに合言葉やトークンの総当たりができてしまう
-- （auth.uid() が null なので試行回数も数えられない）。
--
-- create function の既定は「PUBLIC に EXECUTE」なので、grant を書いただけでは
-- anon からも呼べたままになる。中身の is_room_owner() で必ず落ちるとはいえ、
-- ここの意図と食い違うので、公開する RPC は全部まとめて revoke しておく。
--
-- can_access_room などの権限判定ヘルパーは、ここに入れてはいけない。
-- RLS ポリシーの式は「問い合わせている本人の権限」で評価されるので、
-- PUBLIC から EXECUTE を落とすと authenticated も失い、全ポリシーが
-- permission denied で落ちる。あれらは既定の PUBLIC のままにしておく。
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_room_preview(text)',
    'public.request_access(text, text, text, text)',
    'public.claim_owner(text, text, text)',
    'public.rotate_room_slug(uuid)',
    'public.rotate_owner_token(uuid)',
    'public.rotate_calendar_token(uuid)',
    'public.clear_calendar_token(uuid)',
    'public.set_join_pin(uuid, text)',
    'public.revoke_all_members(uuid, boolean)',
    'public.delete_my_account(boolean)',
    'public.restore_snapshot(uuid)',
    -- トリガーの内側からしか呼ばない
    'public.room_display_name(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end;
$$;

-- 変更履歴はトリガーと RPC の内側からしか書けない。
-- ここを開けておくと、参加者が「オーナーが権限を変えた」ことにできてしまう。
revoke execute on function public.log_access(uuid, text, text, text) from public, anon, authenticated;

-- 試行回数の台帳も RPC の内側からしか触れない。
-- 外から record_access_attempt(ok=true) を呼べると、ロックを自分で解除できてしまう。
revoke execute on function public.check_access_attempts(uuid, text)          from public, anon, authenticated;
revoke execute on function public.record_access_attempt(uuid, text, boolean) from public, anon, authenticated;


-- =============================================================================
--  6. リアルタイム配信
--
--     DELETE イベントは RLS の対象外で、old レコードがそのテーブルの購読者全員に届く。
--     REPLICA IDENTITY FULL だと、消した付箋の本文や通知の中身が、そのボードを読めない
--     人にまで流れてしまう。そこで (id, room_id) の一意インデックスを replica identity に
--     して、DELETE で流れるのを id と room_id だけにする（room_id は購読のフィルタに要る。
--     クライアントは payload.old.id しか使っていない）。
--     notifications は room_id ではなく user_id で購読しているので (id, user_id)。
-- =============================================================================

do $$
declare
  t     text;
  v_col text;
begin
  foreach t in array array[
    'notes', 'strokes', 'events', 'event_overrides', 'todos', 'images', 'comments',
    'note_votes', 'activities', 'room_members',
    'connectors', 'frames', 'attachments', 'note_reactions',
    'polls', 'poll_options', 'poll_votes', 'calendar_feeds', 'notifications'
  ] loop
    v_col := case when t = 'notifications' then 'user_id' else 'room_id' end;
    execute format('create unique index if not exists %I on public.%I (id, %I)',
                   t || '_replica_idx', t, v_col);
    execute format('alter table public.%I replica identity using index %I',
                   t, t || '_replica_idx');
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;   -- 追加済み
    end;
  end loop;
end;
$$;


-- ---- 在席とカーソルのチャンネル（Realtime Authorization）--------------------
--
-- ここまでの設定（publication）が守るのは postgres_changes だけ。
-- 在席表示とカーソル共有は presence / broadcast で、これは RLS の外にある。
-- Supabase の既定では「有効な JWT を持つ人なら、どんな名前のトピックにも入れる」ため、
-- 一度でもボードに入って id を知った人は、あとでアクセスを取り消されても
--   supabase.channel('presence:<room_id>')
-- に入り続けられる。誰がオンラインか・表示名・見ているタブ・編集中の付箋・
-- マウス座標がそのまま流れるうえ、偽のカーソルを送り込むこともできる。
--
-- これを塞ぐには 2 つが揃っている必要がある:
--   1. realtime.messages に RLS ポリシーを置く（このブロック）
--   2. クライアントがそのチャンネルを private で開く
--      （src/hooks/usePresence.ts の config: { private: true }）
-- private でないチャンネルにはポリシーが適用されないので、片方だけでは効かない。
-- 逆に、ポリシーが無いまま private にすると購読ごと失敗する。必ず両方を反映すること。
--
-- トピック名が 'presence:<uuid>' でなければ realtime_room_id は null を返し、
-- can_access_room(null) は false になる（＝知らない形のトピックは拒否）。
create or replace function public.realtime_room_id(p_topic text)
returns uuid language sql stable
set search_path = '' as $$
  select case
    when p_topic ~ '^presence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then substring(p_topic from 10)::uuid
    else null
  end;
$$;

-- realtime スキーマへの権限もプロジェクトによって異なるので、
-- ここも失敗してスクリプト全体が巻き戻らないように保護しておく。
do $$
begin
  execute 'drop policy if exists board_presence_read on realtime.messages';
  execute $p$
    create policy board_presence_read on realtime.messages for select to authenticated
      using (public.can_access_room(public.realtime_room_id(realtime.topic())))
  $p$;

  execute 'drop policy if exists board_presence_write on realtime.messages';
  execute $p$
    create policy board_presence_write on realtime.messages for insert to authenticated
      with check (public.can_access_room(public.realtime_room_id(realtime.topic())))
  $p$;

  raise notice '在席チャンネルの権限を設定しました。';
exception
  when insufficient_privilege or undefined_table or undefined_function then
    raise warning '在席チャンネルの権限設定をスキップしました（realtime.messages に触れません）。docs/SETUP.md「在席とカーソルの権限」を参照してください。';
end;
$$;


-- =============================================================================
--  7. 画像用ストレージ
--     ファイルは '<room_id>/<uuid>.<拡張子>' というパスに置き、
--     フォルダ名（= room_id）をそのままアクセス判定に使う。
--     バケットは非公開。表示時は署名付き URL を都度発行する。
-- =============================================================================

-- パスの先頭フォルダを room_id として取り出す。uuid 以外なら null を返す
-- （can_access_room(null) は false になるので、想定外のパスは弾かれる）。
--
-- 正規表現は UUID の形そのものにする。以前は '^[0-9a-fA-F-]{36}$' で、
-- ハイフン 36 個のような UUID でない文字列も通っていた。通ってしまうと ::uuid の
-- キャストが 22P02 で落ち、ポリシーの評価ごと例外になる（＝そのバケットへの
-- アクセスが全部エラーになる）。
--
-- 他の関数と方針をそろえて search_path も固定する。security invoker なので
-- 権限昇格は起きないが、storage.foldername を差し替えられる余地は残さない。
create or replace function public.storage_room_id(object_name text)
returns uuid language sql stable
set search_path = '' as $$
  select case
    when (storage.foldername(object_name))[1]
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(object_name))[1])::uuid
    else null
  end;
$$;

-- storage スキーマへの権限はプロジェクトによって異なることがあるため、
-- ここだけは失敗してもスクリプト全体が巻き戻らないように保護しておく。
-- 失敗した場合は docs/SETUP.md の「画像アップロードの設定」を参照してください。
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'board-images', 'board-images', false, 5242880,
    array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  )
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists board_images_select on storage.objects';
  execute $p$
    create policy board_images_select on storage.objects for select to authenticated
      using (bucket_id = 'board-images'
             and public.can_access_room(public.storage_room_id(name)))
  $p$;

  -- 貼る・消すは編集できる人だけ（board-files と同じ条件にそろえる）。
  -- 読むのは can_access_room のままでよい（閲覧のみの人にも画像は見える）。
  execute 'drop policy if exists board_images_insert on storage.objects';
  execute $p$
    create policy board_images_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'board-images'
                  and public.can_edit_room(public.storage_room_id(name)))
  $p$;

  execute 'drop policy if exists board_images_delete on storage.objects';
  execute $p$
    create policy board_images_delete on storage.objects for delete to authenticated
      using (bucket_id = 'board-images'
             and public.can_edit_room(public.storage_room_id(name)))
  $p$;

  -- 添付ファイル用（画像以外も置ける。1 ファイル 10MB まで）
  --
  -- 種類を絞るのは、ブラウザがそのまま描画してしまう形式を置かせないため。
  -- Content-Type はアップロードする側が自由に指定できるので、text/html や
  -- image/svg+xml を通すと、署名付き URL を開いた人のブラウザで
  -- <プロジェクト>.supabase.co のオリジンとして任意の JS が動いてしまう
  -- （利用者が信頼しているドメイン上での完全なフィッシングになる）。
  --
  -- application/octet-stream は「必ずダウンロードになる」ので入れてよい。
  -- 画面側も board-files の署名 URL は download 付きで発行する
  -- （src/hooks/useSignedUrls.ts。<a download> はクロスオリジンでは効かないため）。
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'board-files', 'board-files', false, 10485760,
    array[
      'application/pdf',
      'application/octet-stream',
      'application/zip',
      'application/json',
      'text/plain', 'text/csv', 'text/markdown', 'text/calendar',
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
  )
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists board_files_select on storage.objects';
  execute $p$
    create policy board_files_select on storage.objects for select to authenticated
      using (bucket_id = 'board-files'
             and public.can_access_room(public.storage_room_id(name)))
  $p$;

  execute 'drop policy if exists board_files_insert on storage.objects';
  execute $p$
    create policy board_files_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'board-files'
                  and public.can_edit_room(public.storage_room_id(name)))
  $p$;

  execute 'drop policy if exists board_files_delete on storage.objects';
  execute $p$
    create policy board_files_delete on storage.objects for delete to authenticated
      using (bucket_id = 'board-files'
             and public.can_edit_room(public.storage_room_id(name)))
  $p$;

  raise notice '画像・ファイル用ストレージの設定が完了しました。';
exception
  when others then
    raise warning 'ストレージの設定をスキップしました (%): %。ダッシュボードから手動で設定してください。',
      sqlstate, sqlerrm;
end;
$$;
