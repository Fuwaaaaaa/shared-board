/*
 * purge_queue に積まれた Storage の実体を消す Supabase Edge Function。
 *
 * 画像・添付の行を消したとき（ゴミ箱の期限切れ・完全削除）やボードを消したときに、
 * DB のトリガーが public.purge_queue へ「このファイル / このフォルダを消す」と積む。
 * SQL からは storage.objects の台帳しか触れず S3 の実体は消せないので、
 * ここで Storage API（service_role）を通して消す。pg_cron から毎時呼ばれる想定。
 *
 * デプロイ:
 *   supabase functions deploy purge-storage
 *   （JWT を検証しない設定は supabase/config.toml に書いてあるので、
 *     --no-verify-jwt は要りません。認証は CRON_SHARED_SECRET で行います）
 *
 * 動作:
 *   - attempts < 10 の行を queued_at 順に 200 件取る
 *   - kind='object' はバケットごとにまとめて remove
 *       ただし、まだ images / attachments の行から参照されている path は消さない
 *       （「保存した状態」からの復元は、行を消してから同じ path で入れ直すため）
 *   - kind='prefix' は list を空になるまで回して remove
 *   - 消せた行は削除、失敗した行は attempts + 1 と last_error を書く
 *     （10 回失敗したものは放置される。SETUP.md の確認 SQL で見つけられる）
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { isCronCaller } from '../_shared/cronAuth.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/** 1 回の呼び出しで処理する行数 */
const BATCH = 200
/** これ以上失敗した行は取り出さない */
const MAX_ATTEMPTS = 10
/** list の 1 ページ */
const PAGE = 1000

interface QueueRow {
  id: number
  bucket: string
  kind: 'object' | 'prefix'
  path: string
  attempts: number
}

interface Failure {
  id: number
  attempts: number
  error: string
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/** バケットに対応する、path を持つテーブル */
function tableFor(bucket: string): 'images' | 'attachments' | null {
  if (bucket === 'board-images') return 'images'
  if (bucket === 'board-files') return 'attachments'
  return null
}

/**
 * '<room_id>/…' の形をしているか。
 *
 * purge_queue に積まれる path は、消えた行の storage_path をそのまま持ってきた値。
 * DB 側にも「storage_path は自分のボードのフォルダ配下」という制約を入れたが、
 * ここは service_role で実体を消しに行く最後の場所なので、もう一度形を確かめる。
 * 制約より前に入った行や、将来べつの経路で積まれた行を通さないための壁。
 */
const ROOM_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//

function isInRoomFolder(path: string): boolean {
  return ROOM_FOLDER.test(path) && !path.includes('..')
}

/** まだ行から参照されている path（消してはいけないもの） */
async function referencedPaths(bucket: string, paths: string[]): Promise<Set<string>> {
  const table = tableFor(bucket)
  if (!table || paths.length === 0) return new Set()

  const { data, error } = await admin.from(table).select('storage_path').in('storage_path', paths)
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map((row) => row.storage_path as string))
}

/** '<room_id>/' 以下を空になるまで消す。消した数を返す */
async function removePrefix(bucket: string, prefix: string): Promise<number> {
  const folder = prefix.replace(/\/+$/, '')
  let removed = 0

  // 消しながら進むので offset は常に 0。万一 remove が効かないときに回り続けないよう回数を切る
  for (let page = 0; page < 100; page++) {
    const { data, error } = await admin.storage.from(bucket).list(folder, { limit: PAGE, offset: 0 })
    if (error) throw new Error(error.message)

    // id が null の項目は「フォルダ」。この作りでは出ないはずだが、出ても消せないので飛ばす
    const files = (data ?? []).filter((entry) => entry.id !== null)
    if (files.length === 0) break

    const { error: removeError } = await admin.storage
      .from(bucket)
      .remove(files.map((file) => `${folder}/${file.name}`))
    if (removeError) throw new Error(removeError.message)

    removed += files.length
    if (files.length < PAGE) break
  }

  return removed
}

Deno.serve(async (req) => {
  // 合言葉を持つ呼び出し（pg_cron）だけ受け付ける
  if (!(await isCronCaller(req))) {
    return new Response('unauthorized', { status: 401 })
  }

  const { data, error } = await admin
    .from('purge_queue')
    .select('id, bucket, kind, path, attempts')
    .lt('attempts', MAX_ATTEMPTS)
    .order('queued_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(BATCH)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const doneIds: number[] = []
  const failures: Failure[] = []
  let removedObjects = 0
  let removedByPrefix = 0
  let skipped = 0
  let malformed = 0

  const rows: QueueRow[] = []
  for (const row of (data ?? []) as QueueRow[]) {
    if (isInRoomFolder(row.path)) {
      rows.push(row)
      continue
    }
    // 形がおかしい予約は「消さずに」捨てる。何度も試して詰まらせない
    console.warn('purge: パスの形が不正な予約を捨てました', row.id, row.bucket, row.kind)
    doneIds.push(row.id)
    malformed++
  }

  // ---- object: バケットごとにまとめて消す ----
  const byBucket = new Map<string, QueueRow[]>()
  for (const row of rows) {
    if (row.kind !== 'object') continue
    const group = byBucket.get(row.bucket) ?? []
    group.push(row)
    byBucket.set(row.bucket, group)
  }

  for (const [bucket, group] of byBucket) {
    let referenced: Set<string>
    try {
      referenced = await referencedPaths(bucket, group.map((row) => row.path))
    } catch (e) {
      for (const row of group) {
        failures.push({ id: row.id, attempts: row.attempts + 1, error: String(e).slice(0, 500) })
      }
      continue
    }

    const toRemove: QueueRow[] = []
    for (const row of group) {
      if (referenced.has(row.path)) {
        // まだ使われている。予約だけ捨てる（消してはいけない）
        doneIds.push(row.id)
        skipped++
      } else {
        toRemove.push(row)
      }
    }
    if (toRemove.length === 0) continue

    const { error: removeError } = await admin.storage
      .from(bucket)
      .remove(toRemove.map((row) => row.path))

    if (removeError) {
      for (const row of toRemove) {
        failures.push({ id: row.id, attempts: row.attempts + 1, error: removeError.message.slice(0, 500) })
      }
    } else {
      for (const row of toRemove) doneIds.push(row.id)
      removedObjects += toRemove.length
    }
  }

  // ---- prefix: フォルダ丸ごと ----
  for (const row of rows) {
    if (row.kind !== 'prefix') continue
    try {
      removedByPrefix += await removePrefix(row.bucket, row.path)
      doneIds.push(row.id)
    } catch (e) {
      failures.push({ id: row.id, attempts: row.attempts + 1, error: String(e).slice(0, 500) })
    }
  }

  // ---- 台帳の更新 ----
  if (doneIds.length > 0) {
    await admin.from('purge_queue').delete().in('id', doneIds)
  }
  for (const failure of failures) {
    await admin
      .from('purge_queue')
      .update({ attempts: failure.attempts, last_error: failure.error })
      .eq('id', failure.id)
  }

  return new Response(
    JSON.stringify({
      processed: rows.length,
      removedObjects,
      removedByPrefix,
      skipped,
      malformed,
      failed: failures.length,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
