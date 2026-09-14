import { useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { messageOf } from '../lib/errorMessage'
import { enqueue, hasEntry, nextSeq } from '../lib/outboxStore'
import { holdSaving } from '../lib/syncStatus'
import {
  decideOnFailure,
  lockedFields,
  previewOf,
  type QueueTable,
} from '../lib/writeQueue'
import type { useRealtimeTable } from './useRealtimeTable'

/*
 * オフラインのあいだ、ためておける表。
 *
 * 文字が惜しいものだけ。手描き・画像・ファイル・投票などは入れない
 * （理由は README の「制約」と lib/writeQueue.ts の頭）。
 */
const QUEUEABLE: QueueTable[] = ['notes', 'events', 'todos', 'comments']

function queueTableOf(tableName: string): QueueTable | null {
  return (QUEUEABLE as string[]).includes(tableName) ? (tableName as QueueTable) : null
}

interface Row {
  id: string
}

/**
 * useRealtimeTable のうち、楽観的更新に必要な部分だけ。
 * roomData の「削除済みを除いた」テーブルをそのまま渡せる。
 */
export type OptimisticSource<T extends Row> = Pick<
  ReturnType<typeof useRealtimeTable<T>>,
  'upsertLocal' | 'removeLocal' | 'patchLocal' | 'getRow' | 'holdLocal' | 'applyServerRow'
>

export type PatchResult = 'ok' | 'conflict' | 'error'

export interface PatchOptions {
  /** 通知文の「〜できませんでした」の前に入る言葉 */
  what?: string
  /**
   * 楽観ロック。指定すると `updated_at = expectUpdatedAt` の行だけを更新する。
   * 0 行なら最新行を取り、こちらが触るフィールドが変わっていなければ 1 回だけ再試行、
   * 変わっていれば 'conflict' を返してローカルを最新行に合わせる。
   * 'conflict' のときも notify する（呼び出し側で改めて知らせなくてよい）。
   */
  expectUpdatedAt?: string
}

/** PostgREST の in() に並べる id の数。URL 長の上限に当たらないように分ける */
const CHUNK = 200

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function pick<T extends object>(row: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const key of keys) out[key] = row[key]
  return out
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/*
 * 作成がまだ返っていない行。
 *
 * 付箋を貼ってすぐ文字を書くと、INSERT の返事より先に同じ行への UPDATE が届く。
 * サーバーにはまだ行が無いので 0 行で終わり、patch は「すでに消されています」と
 * 判断して書いた文字を捨てていた（位置の変更も同じく巻き戻っていた）。そのあと
 * INSERT が通るので、リロードすると文字の無い付箋だけが残る。回線が遅いと人の手でも起きる。
 *
 * そこで、同じ行への次の書き込みは、作成の結果が出てからサーバーへ送る。
 * 画面への反映はこれまでどおりその場でするので、待つのは通信だけ。
 *
 * ここで持つのは「insert() がいま送っている作成」だけ。送信箱で送り直しを待っている
 * 作成や、送信箱がいま送っている作成は、送信箱そのものを見る（routeFor）。
 *
 * 別の画面が同じ表を別の useOptimisticTable で持っていても取り違えないよう、
 * フックの中ではなくモジュールに置き、表の名前と id の組で引く。
 */
type CreateOutcome = 'saved' | 'queued' | 'failed'
const pendingCreates = new Map<string, Promise<CreateOutcome>>()

const createKey = (tableName: string, id: string) => `${tableName}:${id}`

/** その行の作成を待つ。作成中でなければ null（ふつうの行） */
function createOutcome(tableName: string, id: string): Promise<CreateOutcome> | null {
  return pendingCreates.get(createKey(tableName, id)) ?? null
}

/**
 * 「保留 → ローカル反映 → 送信 → 失敗なら戻して知らせる」を 1 か所にまとめる。
 *
 * 各タブに散らばっていた insert / delete / update の複製をこれに寄せ、
 * サーバーが返した行（updated_at など）を必ずローカルに取り込む。
 * 送信中は useRealtimeTable の保留で、refetch や他の人のエコーに負けないようにする。
 */
export function useOptimisticTable<T extends Row>(
  tableName: string,
  table: OptimisticSource<T>,
  notify: (msg: string) => void,
  /** ためるときに要る。渡さなければ、ためずにこれまでどおり失敗する */
  queueContext?: { roomId: string; userId: string },
) {
  // notify（setNotice を包んだもの）は毎回変わり得るので ref 経由にし、戻り値の identity を保つ
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  const contextRef = useRef(queueContext)
  contextRef.current = queueContext

  return useMemo(() => {
    const fail = (what: string, e: unknown) => {
      notifyRef.current(`${what}できませんでした: ${messageOf(e)}`)
    }

    /*
     * 送れなかったものを送信箱へ回す。回せたら true。
     *
     * 回すのは「通信そのものが届かなかった」ときだけ。権限や決まりの違反は
     * つながり直しても同じ結果なので、これまでどおりその場で失敗にする。
     * 回したときはローカルの見た目を戻さず、通知も出さない——書いた人からは
     * 「保存された」ように見えるのが正しい（ヘッダーのピルが未送信を示す）。
     */
    async function queueOrFail(
      e: unknown,
      make: () => Parameters<typeof enqueue>[0] | null,
    ): Promise<boolean> {
      if (decideOnFailure(e) !== 'queue') return false
      return queueNow(make)
    }

    /*
     * 送らずに、そのまま送信箱へ入れる。入れられたら true。
     *
     * 作成が送信箱に居る行への変更に使う。サーバーにはまだ行が無いので、送っても
     * 0 行で終わるだけ。送信箱に入れれば、作成と 1 件に畳まれる（writeQueue.collapse）。
     */
    async function queueNow(make: () => Parameters<typeof enqueue>[0] | null): Promise<boolean> {
      const context = contextRef.current
      const queueTable = queueTableOf(tableName)
      if (!context || !queueTable) return false

      const op = make()
      if (!op) return false

      if (await enqueue(op)) return true

      notifyRef.current(
        'この内容は大きすぎて、オフラインのあいだ手元にためておけません。つながってからお試しください。',
      )
      return false
    }

    /*
     * その行への次の書き込みを、どう扱うか。
     *
     *   'send'   … サーバーへ送ってよい
     *   'queue'  … 送信箱にその行の分が残っている。追い越さずに、その後ろに並べる
     *   'failed' … 作成に失敗した。行はどこにも無く、失敗はもう知らせてある
     *
     * 送信箱に残っているのは、送り直しを待っている作成・いま送っている作成・
     * 通信が切れて止まっている書き換えなど。どれも「サーバーはまだその続きを知らない」
     * ので、同じ行の次の書き込みを直接送ると順番が入れ替わる。
     */
    async function routeFor(id: string): Promise<'send' | 'queue' | 'failed'> {
      if ((await createOutcome(tableName, id)) === 'failed') return 'failed'
      const context = contextRef.current
      const queueTable = queueTableOf(tableName)
      if (context && queueTable && hasEntry(context.roomId, queueTable, id)) return 'queue'
      return 'send'
    }

    /** 行を足す。成功したら true。失敗した分は画面から消して知らせる */
    async function insert(rows: T[], what = '保存'): Promise<boolean> {
      if (rows.length === 0) return true
      const saving = holdSaving()
      const releases = rows.map((row) => table.holdLocal(row.id, 'insert'))
      for (const row of rows) table.upsertLocal(row)

      const settle = new Map<string, (outcome: CreateOutcome) => void>()
      const gates = new Map<string, Promise<CreateOutcome>>()
      for (const row of rows) {
        const gate = new Promise<CreateOutcome>((resolve) => settle.set(row.id, resolve))
        gates.set(row.id, gate)
        pendingCreates.set(createKey(tableName, row.id), gate)
      }

      /** 送信箱に入れるときの 1 件 */
      const createOp = (row: T) => () => {
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)
        if (!context || !queueTable) return null
        return {
          roomId: context.roomId,
          table: queueTable,
          rowId: row.id,
          userId: context.userId,
          kind: 'create' as const,
          row: row as unknown as Record<string, unknown>,
          label: what,
          preview: previewOf(
            (row as unknown as Record<string, unknown>).text ??
              (row as unknown as Record<string, unknown>).title ??
              (row as unknown as Record<string, unknown>).body,
          ),
          seq: nextSeq(),
        }
      }

      const done = new Set<string>()
      const queued = new Set<string>()
      let sendRows = rows
      try {
        /*
         * 同じ id の分が送信箱に残っている（送信箱にある作成を消したあと、取り消しで
         * 作り直した など）なら、送らずにその後ろに並べる。先に INSERT を送ると、
         * あとから送信箱の DELETE が届いて、作り直した行が消える。
         */
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)
        if (context && queueTable && rows.some((row) => hasEntry(context.roomId, queueTable, row.id))) {
          sendRows = []
          for (const row of rows) {
            if (!hasEntry(context.roomId, queueTable, row.id)) sendRows.push(row)
            // 入れられなかった（大きすぎる）行は、下の後始末で画面から外す。理由は queueNow が知らせている
            else if (await queueNow(createOp(row))) queued.add(row.id)
          }
        }

        for (const chunk of chunks(sendRows, CHUNK)) {
          const { data, error } = await supabase.from(tableName).insert(chunk).select()
          if (error) throw error
          for (const row of chunk) done.add(row.id)
          for (const row of (data ?? []) as T[]) table.applyServerRow(row)
        }

        const unqueued = rows.filter((row) => !done.has(row.id) && !queued.has(row.id))
        for (const row of unqueued) table.removeLocal(row.id)
        return unqueued.length === 0
      } catch (e) {
        const rest = sendRows.filter((row) => !done.has(row.id))
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)

        if (context && queueTable && decideOnFailure(e) === 'queue') {
          for (const row of rest) {
            if (await queueOrFail(e, createOp(row))) queued.add(row.id)
          }
          // 全部ためられたなら、書いた人から見れば「保存された」でよい
          if (rows.every((row) => done.has(row.id) || queued.has(row.id))) return true
        }

        /*
         * 途中まで入った分と、送信箱へためられた分は画面に残す。
         * ためたものまで消すと、送信箱には居るのに盤面から消える
         * （オーバーレイは signature が同じだと足し直さないので、
         *  読み込み直すまで戻ってこない）。
         */
        for (const row of rows) {
          if (done.has(row.id) || queued.has(row.id)) continue
          table.removeLocal(row.id)
        }
        fail(what, e)
        return false
      } finally {
        saving()
        for (const release of releases) release()
        // 待たせていた同じ行への書き込みを、結果に合わせて先へ進める
        for (const row of rows) {
          const key = createKey(tableName, row.id)
          // 同じ id がもう一度作られている（取り消しで作り直した など）なら、そちらは残す
          if (pendingCreates.get(key) === gates.get(row.id)) pendingCreates.delete(key)
          settle.get(row.id)?.(done.has(row.id) ? 'saved' : queued.has(row.id) ? 'queued' : 'failed')
        }
      }
    }

    /** 行を本当に消す。成功したら true。消せなかった分は画面に戻して知らせる */
    async function remove(rows: T[], what = '削除'): Promise<boolean> {
      if (rows.length === 0) return true
      const saving = holdSaving()
      const releases = rows.map((row) => table.holdLocal(row.id, 'delete'))
      for (const row of rows) table.removeLocal(row.id)

      /** 送信箱に入れるときの 1 件 */
      const deleteOp = (row: T) => () => {
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)
        if (!context || !queueTable) return null
        return {
          roomId: context.roomId,
          table: queueTable,
          rowId: row.id,
          userId: context.userId,
          kind: 'delete' as const,
          label: what,
          preview: previewOf(
            (row as unknown as Record<string, unknown>).text ??
              (row as unknown as Record<string, unknown>).title ??
              (row as unknown as Record<string, unknown>).body,
          ),
          seq: nextSeq(),
        }
      }

      const done = new Set<string>()
      // 作成に失敗していた行。どこにも無いので戻さないが、消せたことにもしない
      const failedCreate = new Set<string>()
      try {
        /*
         * 作成中の行は、結果が出てから消す。先に DELETE が届くと 0 行で終わり、
         * あとから INSERT が通って、消したはずの行が戻ってくる。
         *
         * 送信箱にその行の分が残っているなら、送信箱の作成を黙って捨てずに、
         * 消す指示をその後ろに並べる。作成は返事が失われただけで実は届いていることがあり、
         * 捨てると消したはずの行がサーバーに残る（writeQueue.collapse）。
         *
         * 作成に失敗していた行は、消せたことにしない。true を返すと呼び出し側が
         * 「削除」を取り消しの山に積み、Ctrl+Z が無い行を戻そうとして毎回失敗する。
         */
        const routes = await Promise.all(rows.map((row) => routeFor(row.id)))
        const sendRows: T[] = []
        for (const [i, row] of rows.entries()) {
          if (routes[i] === 'failed') {
            failedCreate.add(row.id)
          } else if (routes[i] === 'queue') {
            if (await queueNow(deleteOp(row))) done.add(row.id)
          } else {
            sendRows.push(row)
          }
        }

        for (const chunk of chunks(sendRows, CHUNK)) {
          const ids = chunk.map((row) => row.id)
          const { data, error } = await supabase
            .from(tableName)
            .delete()
            .in('id', ids)
            .select('id')
          if (error) throw error
          for (const row of (data ?? []) as Row[]) done.add(row.id)

          // RLS に弾かれると「エラーなし・0 行」になる。サーバーに残っていれば画面に戻す
          const missing = ids.filter((id) => !done.has(id))
          if (missing.length > 0) {
            const { data: remaining } = await supabase
              .from(tableName)
              .select('id')
              .in('id', missing)
            const stillThere = new Set(((remaining ?? []) as Row[]).map((row) => row.id))
            for (const id of missing) if (!stillThere.has(id)) done.add(id)
            if (stillThere.size > 0) {
              throw new Error(
                stillThere.size === ids.length
                  ? '消す権限がありません'
                  : `${stillThere.size} 件は消す権限がありません`,
              )
            }
          }
        }

        // 送信箱に入れられなかった行は画面に戻す（理由は queueNow が知らせている）
        const unqueued = rows.filter((row) => !done.has(row.id) && !failedCreate.has(row.id))
        for (const row of unqueued) table.upsertLocal(row)
        return unqueued.length === 0 && failedCreate.size === 0
      } catch (e) {
        /*
         * サーバーにもうある行の削除は、通信が切れても送信箱にためない。
         * つながり直すまで「消えたように見えて実は残っている」状態を作るより、
         * その場で戻して知らせるほうが分かりやすい。
         */
        for (const row of rows) {
          if (!done.has(row.id) && !failedCreate.has(row.id)) table.upsertLocal(row)
        }
        fail(what, e)
        return false
      } finally {
        saving()
        for (const release of releases) release()
      }
    }

    /**
     * 1 行の一部を変える。
     * expectUpdatedAt を渡すと楽観ロックになる（付箋の本文・タグなど、
     * 同時に編集すると黙って上書きになるものに使う）。
     */
    async function patch(
      id: string,
      changes: Partial<T>,
      { what = '保存', expectUpdatedAt }: PatchOptions = {},
    ): Promise<PatchResult> {
      const fields = Object.keys(changes) as (keyof T)[]
      if (fields.length === 0) return 'ok'

      const saving = holdSaving()
      const release = table.holdLocal(id, fields)
      const before = table.patchLocal(id, changes)
      const rollback = () => {
        if (before) table.patchLocal(id, pick(before, fields))
      }

      /** 送信箱に入れるときの 1 件 */
      const updateOp = () => {
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)
        if (!context || !queueTable) return null
        const locked = lockedFields(queueTable, changes as Record<string, unknown>)
        return {
          roomId: context.roomId,
          table: queueTable,
          rowId: id,
          userId: context.userId,
          kind: 'update' as const,
          patch: changes as Record<string, unknown>,
          base: before ? (pick(before, fields) as Record<string, unknown>) : undefined,
          /*
           * 文字と意味を持つ列を変えるときだけ、楽観ロックを掛けて送り直す。
           * 位置や色は掛けない（掛けると譲り合いになって動かせなくなる）。
           */
          expectUpdatedAt:
            locked.length > 0
              ? (expectUpdatedAt ??
                ((before as Record<string, unknown> | undefined)?.updated_at as string | undefined))
              : undefined,
          label: what,
          preview: previewOf(
            (changes as Record<string, unknown>).text ??
              (changes as Record<string, unknown>).title ??
              (changes as Record<string, unknown>).body ??
              (before as Record<string, unknown> | undefined)?.text ??
              // ゴミ箱に入れるだけの変更は changes に文字が無い。元の行から拾わないと
              // 送信箱に中身の無い行が並ぶ（コメントは text ではなく body を持つ）
              (before as Record<string, unknown> | undefined)?.title ??
              (before as Record<string, unknown> | undefined)?.body,
          ),
          seq: nextSeq(),
        }
      }

      try {
        // 作ったばかりの行・送信箱に分が残っている行は、追い越さない（routeFor）
        const route = await routeFor(id)
        if (route === 'failed') {
          // 作成に失敗したことはもう知らせてあり、行も画面から消えている。重ねて知らせない
          release()
          return 'error'
        }
        if (route === 'queue') {
          if (await queueNow(updateOp)) {
            release()
            return 'ok'
          }
          // 入れられなかった理由（大きすぎる）は queueNow が知らせている。
          // 送信箱の後ろに並べられないものを、追い越して直接送ることはしない
          release()
          rollback()
          return 'error'
        }

        // 作成が返ったあとなら、expectUpdatedAt は作成前の値のままで合わない。
        // そのときは下の「updated_at が合わなかった」を 1 回通って揃う
        let expect = expectUpdatedAt
        for (let attempt = 0; attempt < 2; attempt++) {
          let query = supabase.from(tableName).update(changes as Record<string, unknown>).eq('id', id)
          if (expect) query = query.eq('updated_at', expect)
          const { data, error } = await query.select()
          if (error) throw error

          const saved = ((data ?? []) as T[])[0]
          if (saved) {
            release()
            table.applyServerRow(saved)
            return 'ok'
          }

          if (!expect) {
            throw new Error('変更が保存されませんでした（権限がないか、すでに消えています）')
          }

          // updated_at が合わなかった。最新行を見て、こちらが触るフィールドが
          // 変わっていなければ（別の理由で updated_at が進んだだけなら）もう 1 回だけ試す
          const { data: latest, error: latestError } = await supabase
            .from(tableName)
            .select('*')
            .eq('id', id)
            .maybeSingle()
          if (latestError) throw latestError

          if (!latest) {
            release()
            table.removeLocal(id)
            notifyRef.current(`${what}できませんでした: すでに消されています`)
            return 'conflict'
          }

          const latestRow = latest as T
          const beforeRow = (before ?? {}) as Partial<T>
          const watched = fields.filter((f) => f === 'text' || f === 'tags')
          const untouched =
            attempt === 0 &&
            watched.every((f) => sameJson(beforeRow[f], latestRow[f])) &&
            'updated_at' in latestRow

          if (untouched) {
            // 相手の変更（こちらが触らないフィールド）は取り込みつつ、自分の変更は保留で守る
            table.applyServerRow(latestRow)
            expect = String((latestRow as Record<string, unknown>).updated_at)
            continue
          }

          // 競合したことは必ず知らせる。黙って最新行に差し替えると、
          // undo / redo からここに来たときに「Ctrl+Z が効かない」としか見えない
          // （undo は成功扱いで消費され、画面だけが期待と違う状態で残る）。
          release()
          table.upsertLocal(latestRow)
          notifyRef.current('他の人が先に変更しました。最新の内容に戻しています。')
          return 'conflict'
        }
        throw new Error('他の人の変更と重なりました')
      } catch (e) {
        if (await queueOrFail(e, updateOp)) {
          release()
          return 'ok'
        }

        release()
        rollback()
        fail(what, e)
        return 'error'
      } finally {
        saving()
      }
    }

    /** 複数行に同じ変更を入れる（ゴミ箱に入れる・戻す など） */
    async function patchMany(rows: T[], changes: Partial<T>, what = '保存'): Promise<boolean> {
      if (rows.length === 0) return true
      const fields = Object.keys(changes) as (keyof T)[]
      if (fields.length === 0) return true

      const saving = holdSaving()
      const releases = rows.map((row) => table.holdLocal(row.id, fields))
      const befores = new Map<string, T | undefined>()
      for (const row of rows) befores.set(row.id, table.patchLocal(row.id, changes))

      /*
       * 送信箱に入れるときの 1 件。
       *
       * 楽観ロックは掛けない。ここへ来るのはゴミ箱の出し入れや一括の色替えで、
       * 掛けると譲り合いになって動かせなくなる（patch 側と同じ判断）。
       */
      const updateOpFor = (row: T) => () => {
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)
        if (!context || !queueTable) return null
        const before = befores.get(row.id)
        return {
          roomId: context.roomId,
          table: queueTable,
          rowId: row.id,
          userId: context.userId,
          kind: 'update' as const,
          patch: changes as Record<string, unknown>,
          base: before ? (pick(before, fields) as Record<string, unknown>) : undefined,
          label: what,
          preview: previewOf(
            (row as unknown as Record<string, unknown>).text ??
              (row as unknown as Record<string, unknown>).title ??
              (row as unknown as Record<string, unknown>).body,
          ),
          seq: nextSeq(),
        }
      }

      const done = new Set<string>()
      const queued = new Set<string>()
      /*
       * 送らなかった行。作成に失敗していた行（もう画面に無く、失敗も知らせてある）と、
       * 送信箱の後ろに並べるはずが入れられなかった行（大きすぎる。queueNow が知らせている）。
       * どちらも済んだことにはしない。true を返すと呼び出し側が取り消しの山に積み、
       * Ctrl+Z が無い行を戻そうとして毎回失敗する。
       */
      const blocked = new Set<string>()
      const savedRows: T[] = []
      const sendRows: T[] = []

      /** 画面を変更前に戻す（作成に失敗していた行は、もう画面に無いので何も起きない） */
      const restore = (ids: Set<string>) => {
        for (const id of ids) {
          const before = befores.get(id)
          if (before) table.patchLocal(id, pick(before, fields))
        }
      }
      try {
        // 作ったばかりの行・送信箱に分が残っている行は、追い越さない（routeFor）
        const routes = await Promise.all(rows.map((row) => routeFor(row.id)))
        for (const [i, row] of rows.entries()) {
          if (routes[i] === 'failed') blocked.add(row.id)
          else if (routes[i] === 'send') sendRows.push(row)
          else if (await queueNow(updateOpFor(row))) queued.add(row.id)
          // 送信箱の後ろに並べられないものを、追い越して直接送ることはしない
          else blocked.add(row.id)
        }

        for (const chunk of chunks(sendRows, CHUNK)) {
          const ids = chunk.map((row) => row.id)
          const { data, error } = await supabase
            .from(tableName)
            .update(changes as Record<string, unknown>)
            .in('id', ids)
            .select()
          if (error) throw error
          const saved = (data ?? []) as T[]
          for (const row of saved) {
            done.add(row.id)
            savedRows.push(row)
          }
          if (saved.length < ids.length) {
            throw new Error(
              saved.length === 0
                ? '変更が保存されませんでした（権限がないか、すでに消えています）'
                : `${ids.length - saved.length} 件は保存されませんでした`,
            )
          }
        }

        restore(blocked)
        return blocked.size === 0
      } catch (e) {
        const rest = sendRows.filter((row) => !done.has(row.id))

        /*
         * まとめての変更も、1 件ずつのときと同じように送信箱へ回す。
         * 回さないでいると、本文の書き換えはためられるのに、ゴミ箱へ入れるのは
         * その場で失敗する——同じ画面の中で挙動が割れる。
         */
        if (decideOnFailure(e) === 'queue') {
          for (const row of rest) {
            if (await queueOrFail(e, updateOpFor(row))) queued.add(row.id)
          }
          if (rest.every((row) => queued.has(row.id))) {
            restore(blocked)
            return blocked.size === 0
          }
        }

        restore(new Set(rows.map((row) => row.id).filter((id) => !done.has(id) && !queued.has(id))))
        fail(what, e)
        return false
      } finally {
        saving()
        for (const release of releases) release()
        // 保留を外してからサーバーの行を取り込む（updated_at などを揃える）
        for (const row of savedRows) table.applyServerRow(row)
      }
    }

    return { insert, remove, patch, patchMany }
  }, [tableName, table])
}
