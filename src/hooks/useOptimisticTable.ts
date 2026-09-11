import { useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { messageOf } from '../lib/errorMessage'
import { cancelPendingCreate, enqueue, nextSeq } from '../lib/outboxStore'
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
      const context = contextRef.current
      const queueTable = queueTableOf(tableName)
      if (!context || !queueTable) return false
      if (decideOnFailure(e) !== 'queue') return false

      const op = make()
      if (!op) return false

      if (await enqueue(op)) return true

      notifyRef.current(
        'この内容は大きすぎて、オフラインのあいだ手元にためておけません。つながってからお試しください。',
      )
      return false
    }

    /** 行を足す。成功したら true。失敗した分は画面から消して知らせる */
    async function insert(rows: T[], what = '保存'): Promise<boolean> {
      if (rows.length === 0) return true
      const releases = rows.map((row) => table.holdLocal(row.id, 'insert'))
      for (const row of rows) table.upsertLocal(row)

      const done = new Set<string>()
      try {
        for (const chunk of chunks(rows, CHUNK)) {
          const { data, error } = await supabase.from(tableName).insert(chunk).select()
          if (error) throw error
          for (const row of chunk) done.add(row.id)
          for (const row of (data ?? []) as T[]) table.applyServerRow(row)
        }
        return true
      } catch (e) {
        const rest = rows.filter((row) => !done.has(row.id))
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)

        const queued = new Set<string>()
        if (context && queueTable && decideOnFailure(e) === 'queue') {
          for (const row of rest) {
            const ok = await queueOrFail(e, () => ({
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
            }))
            if (ok) queued.add(row.id)
          }
          // 全部ためられたなら、書いた人から見れば「保存された」でよい
          if (queued.size === rest.length) return true
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
        for (const release of releases) release()
      }
    }

    /** 行を本当に消す。成功したら true。消せなかった分は画面に戻して知らせる */
    async function remove(rows: T[], what = '削除'): Promise<boolean> {
      if (rows.length === 0) return true
      const releases = rows.map((row) => table.holdLocal(row.id, 'delete'))
      for (const row of rows) table.removeLocal(row.id)

      const done = new Set<string>()
      try {
        for (const chunk of chunks(rows, CHUNK)) {
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
        return true
      } catch (e) {
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)

        /*
         * オフラインで作ってすぐ消したときは、送信箱の「作成」を取り消せば済む。
         * まだ 1 度も送っていないので、送るものが残らない。
         *
         * サーバーにもうある行の削除は、ためない。ためると
         * 「本当に消す」を「ゴミ箱へ入れる」に読み替えることになり、意味が変わる。
         */
        if (context && queueTable && decideOnFailure(e) === 'queue') {
          const canceled: string[] = []
          for (const row of rows) {
            if (done.has(row.id)) continue
            if (await cancelPendingCreate(context.roomId, queueTable, row.id)) {
              canceled.push(row.id)
            }
          }
          if (canceled.length === rows.filter((row) => !done.has(row.id)).length) return true
          for (const id of canceled) done.add(id)
        }

        for (const row of rows) if (!done.has(row.id)) table.upsertLocal(row)
        fail(what, e)
        return false
      } finally {
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

      const release = table.holdLocal(id, fields)
      const before = table.patchLocal(id, changes)
      const rollback = () => {
        if (before) table.patchLocal(id, pick(before, fields))
      }

      try {
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
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)

        if (context && queueTable && decideOnFailure(e) === 'queue') {
          const locked = lockedFields(queueTable, changes as Record<string, unknown>)
          const queued = await queueOrFail(e, () => ({
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
                  ((before as Record<string, unknown> | undefined)?.updated_at as
                    | string
                    | undefined))
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
          }))
          if (queued) {
            release()
            return 'ok'
          }
        }

        release()
        rollback()
        fail(what, e)
        return 'error'
      }
    }

    /** 複数行に同じ変更を入れる（ゴミ箱に入れる・戻す など） */
    async function patchMany(rows: T[], changes: Partial<T>, what = '保存'): Promise<boolean> {
      if (rows.length === 0) return true
      const fields = Object.keys(changes) as (keyof T)[]
      if (fields.length === 0) return true

      const releases = rows.map((row) => table.holdLocal(row.id, fields))
      const befores = new Map<string, T | undefined>()
      for (const row of rows) befores.set(row.id, table.patchLocal(row.id, changes))

      const done = new Set<string>()
      const savedRows: T[] = []
      try {
        for (const chunk of chunks(rows, CHUNK)) {
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
        return true
      } catch (e) {
        const rest = rows.filter((row) => !done.has(row.id))
        const context = contextRef.current
        const queueTable = queueTableOf(tableName)

        /*
         * まとめての変更も、1 件ずつのときと同じように送信箱へ回す。
         * 回さないでいると、本文の書き換えはためられるのに、ゴミ箱へ入れるのは
         * その場で失敗する——同じ画面の中で挙動が割れる。
         *
         * 楽観ロックは掛けない。ここへ来るのはゴミ箱の出し入れや一括の色替えで、
         * 掛けると譲り合いになって動かせなくなる（patch 側と同じ判断）。
         */
        const queued = new Set<string>()
        if (context && queueTable && decideOnFailure(e) === 'queue') {
          for (const row of rest) {
            const before = befores.get(row.id)
            const ok = await queueOrFail(e, () => ({
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
            }))
            if (ok) queued.add(row.id)
          }
          if (queued.size === rest.length) return true
        }

        for (const row of rows) {
          if (done.has(row.id) || queued.has(row.id)) continue
          const before = befores.get(row.id)
          if (before) table.patchLocal(row.id, pick(before, fields))
        }
        fail(what, e)
        return false
      } finally {
        for (const release of releases) release()
        // 保留を外してからサーバーの行を取り込む（updated_at などを揃える）
        for (const row of savedRows) table.applyServerRow(row)
      }
    }

    return { insert, remove, patch, patchMany }
  }, [tableName, table])
}
