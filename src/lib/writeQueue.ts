/*
 * オフラインのあいだの書き込みをためておく「送信箱」の、判断の部分。
 *
 * ここには React も IndexedDB も DOM も持ち込まない。ためる場所は writeQueueDb.ts、
 * 実際に送るのは useWriteQueue.ts が受け持つ。いちばん間違えやすいのが
 * 「畳み方」と「失敗の見分け」なので、そこだけを純粋な関数にしてテストする。
 *
 * この作りが成り立つのは、アプリが行の id をクライアントで作っているから
 * （crypto.randomUUID）。ふつうオフラインのキューを難しくするのは
 * 「あとから決まる id をどう差し替えるか」だが、ここではその問題が最初から無い。
 */

/** ためる対象の表。第 1 弾は「文字が惜しいもの」だけ */
export type QueueTable = 'notes' | 'events' | 'todos' | 'comments'

/**
 * 送る順。子が親より先に行くと外部キーで弾かれる。
 * todos.source_note_id / source_event_id は本物の外部キー（schema.sql）。
 */
export const FLUSH_ORDER: QueueTable[] = ['notes', 'events', 'todos', 'comments']

export type QueueKind = 'create' | 'update' | 'delete'
export type QueueState = 'pending' | 'sending' | 'failed'

/** 送れなかった理由。画面の出し分けに使う */
export type FailureReason =
  | 'permission'
  | 'conflict'
  | 'parent_gone'
  | 'full'
  | 'too_long'
  | 'duplicate'
  | 'identity_changed'
  | 'unknown'

export interface QueueEntry {
  /** roomId:table:rowId。1 行につき 1 件だけ持つ（これが畳める理由） */
  key: string
  roomId: string
  table: QueueTable
  rowId: string
  /** ためた時点の auth.uid()。変わっていたらもう送れない */
  userId: string
  kind: QueueKind
  /** create のとき、送る行そのもの（あとから畳んだ書き換えも入っている） */
  row?: Record<string, unknown>
  /**
   * update のとき、積み上げた変更。
   *
   * create のときは「作成のあとに畳んだ書き換え」だけを別に持つ。作成が前にもう
   * 届いていた（主キーの重複で返ってきた）とき、確定したのは作成だけなので、
   * この分を更新として送り直す（afterSend）。
   */
  patch?: Record<string, unknown>
  /** update のとき、ためる前の値（取り消しと、競合の見比べに使う） */
  base?: Record<string, unknown>
  /** update のとき、楽観ロックに使う updated_at */
  expectUpdatedAt?: string
  /** 一覧に出す名前 */
  label: string
  /** 一覧に出す本文の頭。送れなかったときに拾い出すためのもの */
  preview: string
  /** 同じ表の中の順番 */
  seq: number
  /**
   * ためた回数。同じ行へ書き足すたびに 1 つ増える。
   *
   * 送っているあいだに書き足されたかどうかを、これで見分ける
   * （送るのは flush が始めた時点の写しなので、往復中の書き足しは入っていない）。
   */
  rev: number
  enqueuedAt: string
  state: QueueState
  /** サーバーに断られた回数。MAX_ATTEMPTS で打ち切る */
  attempts: number
  /**
   * 通信そのものが届かなかった回数。様子見の間隔を伸ばすためだけに数える。
   * attempts と分けているのは、圏外にいるだけで打ち切られないようにするため。
   */
  transportAttempts?: number
  nextAttemptAt?: number
  reason?: FailureReason
  /** サーバーが返した文言。そのまま見せる */
  errorText?: string
  /** 競合したとき、いまサーバーにある本文 */
  serverText?: string
}

/** 新しくためる 1 件ぶんの指示 */
export interface QueueOp {
  roomId: string
  table: QueueTable
  rowId: string
  userId: string
  kind: QueueKind
  row?: Record<string, unknown>
  patch?: Record<string, unknown>
  base?: Record<string, unknown>
  expectUpdatedAt?: string
  label: string
  preview: string
  seq: number
}

export function keyOf(roomId: string, table: QueueTable, rowId: string): string {
  return `${roomId}:${table}:${rowId}`
}

/**
 * 同じ行への操作を 1 件に畳む。
 *
 * 操作のログを再生するのではなく、行ごとの最終状態だけを持つ。
 * こうすると「作って 12 回直した付箋」は INSERT 1 回になり、
 * 「60 枚貼って取り消した」は中身を 1 文字も送らずに済む（消す指示だけが残る）。
 * 件数の上限（tg_limit_rows_per_room）が見るのも、畳んだあとの数になる。
 *
 * delete は「id を指定して本当に消す」。ゴミ箱へ入れるのは deleted_at の update で、
 * こちらには来ない。
 */
export function collapse(existing: QueueEntry | undefined, op: QueueOp): QueueEntry {
  const base: QueueEntry = {
    key: keyOf(op.roomId, op.table, op.rowId),
    roomId: op.roomId,
    table: op.table,
    rowId: op.rowId,
    userId: op.userId,
    kind: op.kind,
    label: op.label,
    preview: op.preview,
    seq: existing?.seq ?? op.seq,
    rev: (existing?.rev ?? 0) + 1,
    enqueuedAt: existing?.enqueuedAt ?? new Date().toISOString(),
    state: 'pending',
    attempts: 0,
  }

  if (!existing) {
    if (op.kind === 'create') return { ...base, row: op.row }
    if (op.kind === 'update') {
      return { ...base, patch: op.patch, base: op.base, expectUpdatedAt: op.expectUpdatedAt }
    }
    return { ...base, base: op.base }
  }

  /*
   * 作ってから消したときも、なかったことにはしない。
   *
   * 送信箱の作成は、どれも一度は送ろうとして返事を受け取れなかったもの。通信の途中で
   * 切れただけで、サーバーには実は届いていることがある。ここで捨てると、その行が
   * 消えずに残り、他の人の画面や次の読み込みで戻ってくる。
   *
   * 作成の中身は送らず、id を指定して消す 1 件だけにする。届いていなければ 0 行で
   * 終わるだけで、届いていれば消える。作成 → 削除の順に送るのと、最後の状態は同じ。
   */

  if (existing.kind === 'create' && op.kind === 'update') {
    return {
      ...base,
      kind: 'create',
      row: { ...existing.row, ...op.patch },
      patch: { ...existing.patch, ...op.patch },
    }
  }

  if (existing.kind === 'update' && op.kind === 'update') {
    return {
      ...base,
      kind: 'update',
      patch: { ...existing.patch, ...op.patch },
      // 取り消しの戻り先は「いちばん最初の値」でなければならない
      base: { ...op.base, ...existing.base },
      // ロックもいちばん最初のもの。ただ、先にためたのが位置や色だけ（ロック無し）なら、
      // あとから畳んだ本文の書き換えのロックを使う。捨てると、本文が
      // 他の人の書き換えを黙って上書きする
      expectUpdatedAt: existing.expectUpdatedAt ?? op.expectUpdatedAt,
    }
  }

  if (op.kind === 'delete') {
    return { ...base, kind: 'delete', base: existing.base ?? op.base }
  }

  // 消したあとに作り直した（取り消しのやり直し）。作り直した行で送る
  return { ...base, kind: op.kind, row: op.row, patch: op.patch, base: op.base }
}

/** 送る順に並べる。表をまたぐ順序が先で、同じ表の中は seq 順 */
export function orderForFlush(entries: QueueEntry[]): QueueEntry[] {
  return entries.slice().sort((a, b) => {
    const byTable = FLUSH_ORDER.indexOf(a.table) - FLUSH_ORDER.indexOf(b.table)
    return byTable !== 0 ? byTable : a.seq - b.seq
  })
}

/**
 * 親が送れなかった行を指す列を null にする。
 *
 * 付箋から作ったやることは source_note_id が本物の外部キーなので、
 * 親が入らないまま送ると 23503 で弾かれる。やることの文字は残したいので、
 * 「この付箋から生まれました」のつながりだけを捨てる。
 */
export function nullOrphanRefs(
  row: Record<string, unknown>,
  missingIds: Set<string>,
): Record<string, unknown> {
  const next = { ...row }
  for (const field of ['source_note_id', 'source_event_id', 'source_todo_id'] as const) {
    const value = next[field]
    if (typeof value === 'string' && missingIds.has(value)) next[field] = null
  }
  return next
}

/**
 * 楽観ロックを掛ける列。
 *
 * 文字と意味を持つ列だけ。位置や色は掛けない——掛けると譲り合いになって
 * 動かせなくなる（docs/OVERVIEW.html にある、もとからの方針）。
 * events の 6 列は tg_touch_event_updated_at が見ているものと同じ。
 */
const LOCKED_FIELDS: Record<QueueTable, string[]> = {
  notes: ['text', 'tags'],
  events: ['title', 'description', 'start_at', 'end_at', 'all_day', 'tags'],
  todos: ['title', 'notes', 'tags'],
  comments: ['body'],
}

/** その変更が、楽観ロックを掛けるべき列を含むか */
export function lockedFields(table: QueueTable, patch: Record<string, unknown>): string[] {
  return LOCKED_FIELDS[table].filter((field) => field in patch)
}

/**
 * ロックを掛けた更新が 0 行で返ったとき、サーバーの行がもう送ろうとした中身に
 * なっているか。
 *
 * 更新は届いたのに返事だけが失われると、送信箱はためたときのロックのまま送り直す。
 * サーバーの updated_at は自分の書き込みで進んでいるので 0 行になり、
 * 自分の書いたものが「他の人が先に書き換えました」と出てしまう。
 * 送ろうとした列がどれもサーバーと同じなら、送れたものとして片付けてよい
 * （他の人が偶然同じ中身にしていた場合も、結果は同じなので失うものは無い）。
 *
 * 見比べは JSON の文字列で行う。時刻のように書き方が揺れる値は一致しないことが
 * あるが、そのときは今までどおり競合として見せるだけで、黙って捨てはしない。
 */
export function alreadyApplied(
  patch: Record<string, unknown>,
  serverRow: Record<string, unknown> | null,
): boolean {
  if (!serverRow) return false
  const fields = Object.keys(patch)
  return (
    fields.length > 0 &&
    fields.every((field) => JSON.stringify(patch[field]) === JSON.stringify(serverRow[field]))
  )
}

/** 待ち時間（ミリ秒）。最後は 5 分で頭打ち */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000]

/** 何回目の再試行なら、どれだけ待つか */
export function nextBackoff(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
}

/** これ以上は送らない */
export const MAX_ATTEMPTS = 8

/** 1 件がこれより大きければ、ためずに断る（IndexedDB を埋めないため） */
export const MAX_ENTRY_BYTES = 400_000

interface PostgrestLike {
  code?: string
  message?: string
  details?: string
  status?: number
}

function errorOf(e: unknown): PostgrestLike {
  if (e && typeof e === 'object') return e as PostgrestLike
  return { message: String(e) }
}

/**
 * 返ってきた error に、HTTP のステータスを添える。
 *
 * postgrest-js の error は応答の本文を読んだもので、status は結果の側
 * （{ data, error, status }）にしか無い。error だけを投げると、下の
 * decideOnFailure / classifyError が 5xx・429 を見分けられず、混んでいるだけの
 * 失敗まで巻き戻したり、送信箱で「送れなかった」に落としたりする。
 */
export function withStatus(error: object, status: number): PostgrestLike {
  return { ...(error as PostgrestLike), status }
}

/** 通信そのものが届かなかったか。navigator.onLine は当てにしない */
export function isTransportError(e: unknown): boolean {
  if (e && typeof e === 'object' && (e as { isTransport?: boolean }).isTransport) return true
  const message = errorOf(e).message ?? ''
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('Load failed') ||
    message.includes('network')
  )
}

/**
 * 失敗したとき、ためるか・そのまま失敗にするか。
 *
 * navigator.onLine が true のまま死んでいる回線（キャプティブポータル、
 * 不安定なモバイル）が普通にあるので、フラグでは決めない。
 * 「送れなかった」ことそのものを見る。
 */
export function decideOnFailure(e: unknown): 'queue' | 'fail' {
  if (isTransportError(e)) return 'queue'
  const status = errorOf(e).status
  // 中継やゲートウェイの一時的な失敗・混んでいるとき（429）も、ためて送り直すほうがよい
  if (status !== undefined && (status >= 500 || status === 429)) return 'queue'
  return 'fail'
}

/**
 * 送れたあと、その 1 件をどうするか。
 *
 * 送るのは flush が始めた時点の写しなので、往復のあいだに同じ行へ書き足された
 * ぶんは、その写しに入っていない。key だけを見て消すと、書き足しごと消える
 * （書いたのに消えた、がいちばん困る形で起きる）。ためた回数（rev）が
 * 動いていたら、消さずに送り直す側へ回す。
 *
 * ただし「作成」のまま送り直すと、こんどは主キーの重複になり
 * 「前回の送信が実は通っていた」として捨てられ、やはり書き足しが消える。
 * 行はもうサーバーにあるので、更新に変えて送る。
 *
 * id と updated_at を落とすのは、前者が宛先そのもので、後者はサーバーが
 * 進めるものだから。room_id や author_id は残してよい——凍結のトリガーは
 * 「変わったとき」だけ怒るので、同じ値なら通る。
 *
 * alreadyExisted は、作成が主キーの重複で返ってきたとき。確定したのは
 * 「作成は前にもう届いていた」ことだけで、そのあとに畳んだ書き換えは届いていない
 * （重複で断られた INSERT に入っていただけ）。書き換えがあれば更新として送り直し、
 * 無ければ片付ける。これを「全部送れた」と数えると、作ったあとに書いた文字が消える。
 *
 * serverUpdatedAt は、送れた更新のあとの updated_at（サーバーが返した行のもの）。
 * 更新を送り直すときのロックはこれに掛け直す。いま送った更新で updated_at は
 * もう進んでいるので、ためたときの古いロックのままだと、自分の書き込みと
 * 競合したことになり「他の人が先に書き換えました」で止まる。
 */
export function afterSend(
  entry: QueueEntry,
  sentRev: number,
  alreadyExisted = false,
  serverUpdatedAt?: string,
): 'drop' | Partial<QueueEntry> {
  const fresh = {
    state: 'pending' as const,
    attempts: 0,
    transportAttempts: 0,
    nextAttemptAt: undefined,
  }

  if (alreadyExisted && entry.kind === 'create') {
    const patch = { ...(entry.patch ?? {}) }
    delete patch.id
    delete patch.updated_at
    if (Object.keys(patch).length === 0) return 'drop'
    return { ...fresh, kind: 'update', row: undefined, patch, expectUpdatedAt: undefined }
  }

  if (entry.rev === sentRev) return 'drop'

  if (entry.kind !== 'create') {
    return entry.expectUpdatedAt && serverUpdatedAt
      ? { ...fresh, expectUpdatedAt: serverUpdatedAt }
      : fresh
  }

  const row = { ...(entry.row ?? {}) }
  delete row.id
  delete row.updated_at

  return {
    ...fresh,
    kind: 'update',
    row: undefined,
    patch: row,
    // 送り直しは「こちらの内容で上書きする」なので、ロックは掛けない
    expectUpdatedAt: undefined,
  }
}

/**
 * 送れなかったときの、次の状態。
 *
 * 肝は「届かなかった」と「届いたうえで断られた」を分けるところ。
 * 送る側は navigator.onLine を見ていない（嘘をつくフラグなので、下の
 * decideOnFailure のコメントどおり意図的に見ない）ので、届かなかったぶんまで
 * attempts に数えると、ただ圏外にいるだけで打ち切りに達する。
 * 1+2+5+15+60+300+300 秒 ≒ 11 分で送信箱が全件「送れませんでした」になり、
 * 「つながったら送る」という約束が果たせなくなる。
 *
 * 様子見の間隔は伸ばしたいので、そちらは transportAttempts で別に数える。
 */
export function nextRetryState(
  entry: Pick<QueueEntry, 'attempts' | 'transportAttempts'>,
  transport: boolean,
  now: number,
): Partial<QueueEntry> {
  if (transport) {
    const transportAttempts = (entry.transportAttempts ?? 0) + 1
    return {
      state: 'pending',
      transportAttempts,
      nextAttemptAt: now + nextBackoff(transportAttempts - 1),
    }
  }

  const attempts = entry.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    return {
      state: 'failed',
      attempts,
      reason: 'unknown',
      errorText: '何度か試しましたが送れませんでした。',
    }
  }
  return { state: 'pending', attempts, nextAttemptAt: now + nextBackoff(entry.attempts) }
}

export type Classified =
  | { outcome: 'success'; alreadyExisted?: boolean }
  | { outcome: 'retry'; transport?: boolean }
  | { outcome: 'dead'; reason: FailureReason; errorText: string }

/**
 * 送った結果の見分け。
 *
 * 主キーの重複（23505 で details に「Key (id)=」がある）は、
 * 前回の送信が実は通っていたということなので成功として扱う。これが
 * 二重送信（2 つのタブ、通信の途中切れ）を安全にしている。
 * ただし「作成が届いていた」ことしか分からないので、alreadyExisted で呼び出し側に
 * 伝える。そのあとに畳んだ書き換えまで届いたことにはならない（afterSend）。
 *
 * ただし todos には主キー以外の部分一意インデックス
 * （todos_next_occurrence_uidx）があるので、23505 を一括りにはできない。
 * それは別物の行なので、送れなかったものとして残す。
 */
export function classifyError(e: unknown): Classified {
  const error = errorOf(e)
  const code = error.code ?? ''
  const message = error.message ?? ''
  const details = error.details ?? ''

  // 届かなかったのか、届いたうえで断られたのかは、数え方が変わるので呼び出し側へ伝える
  if (isTransportError(e)) return { outcome: 'retry', transport: true }

  const status = error.status
  if (status !== undefined && (status >= 500 || status === 429)) return { outcome: 'retry' }

  if (code === '23505') {
    /*
     * 主キーかどうかは、details の「Key (id)=」か、制約名の「〜_pkey」で見る。
     * PostgREST の版によっては details を返さず（null）、message の制約名しか残らない。
     * details だけを見ていると、届いていた作成が「送れなかった」として止まる。
     */
    const primaryKey = details.includes('Key (id)=') || /unique constraint "\w+_pkey"/.test(message)
    if (primaryKey) return { outcome: 'success', alreadyExisted: true }
    return { outcome: 'dead', reason: 'duplicate', errorText: message }
  }

  if (code === '42501' || message.includes('insufficient_privilege')) {
    return { outcome: 'dead', reason: 'permission', errorText: message }
  }

  if (code === '23503') {
    return { outcome: 'dead', reason: 'parent_gone', errorText: message }
  }

  if (code === '23514') {
    if (message.includes('件までです')) {
      return { outcome: 'dead', reason: 'full', errorText: message }
    }
    if (message.includes('文字までです')) {
      return { outcome: 'dead', reason: 'too_long', errorText: message }
    }
  }

  return { outcome: 'dead', reason: 'unknown', errorText: message || String(e) }
}

/** ためたときと同じ人か。違えば author_id = auth.uid() を満たせない */
export function identityChanged(entry: QueueEntry, userId: string): boolean {
  return entry.userId !== userId
}

/** 一覧に出す 1 行。本文は頭だけ */
export function previewOf(text: unknown, max = 80): string {
  if (typeof text !== 'string') return ''
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** ためるには大きすぎるか */
export function tooLargeToQueue(entry: QueueEntry): boolean {
  return JSON.stringify(entry).length > MAX_ENTRY_BYTES
}
