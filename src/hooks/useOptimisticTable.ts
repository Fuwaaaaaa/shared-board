import { useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { useRealtimeTable } from './useRealtimeTable'

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

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return e instanceof Error ? e.message : String(e)
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
) {
  // notify（setNotice を包んだもの）は毎回変わり得るので ref 経由にし、戻り値の identity を保つ
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  return useMemo(() => {
    const fail = (what: string, e: unknown) => {
      notifyRef.current(`${what}できませんでした: ${messageOf(e)}`)
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
        // 途中まで入った分は残し、入らなかった分だけ戻す
        for (const row of rows) if (!done.has(row.id)) table.removeLocal(row.id)
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
          for (const row of saved) done.add(row.id)
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
        for (const row of rows) {
          if (done.has(row.id)) continue
          const before = befores.get(row.id)
          if (before) table.patchLocal(row.id, pick(before, fields))
        }
        fail(what, e)
        return false
      } finally {
        for (const release of releases) release()
        // 保留を外してからサーバーの行を取り込む（updated_at などを揃える）
      }
    }

    return { insert, remove, patch, patchMany }
  }, [tableName, table])
}
