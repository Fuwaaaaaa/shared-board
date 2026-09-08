import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import {
  dropEntry,
  outboxSnapshot,
  reloadOutbox,
  subscribeOutbox,
  updateEntry,
} from '../lib/outboxStore'
import { onAnnounce, withFlushLock } from '../lib/writeQueueDb'
import {
  classifyError,
  identityChanged,
  MAX_ATTEMPTS,
  nextBackoff,
  nullOrphanRefs,
  orderForFlush,
  type QueueEntry,
} from '../lib/writeQueue'

/** 送るものが残っているときの、様子見の間隔 */
const TICK_MS = 5_000

/** 1 件を送る。送れたら true */
async function send(entry: QueueEntry, userId: string): Promise<boolean> {
  if (identityChanged(entry, userId)) {
    await updateEntry(entry.key, {
      state: 'failed',
      reason: 'identity_changed',
      errorText:
        'この端末の「自分」が変わったため、これはもう送れません。内容をコピーして書き直してください。',
    })
    return false
  }

  try {
    if (entry.kind === 'create') {
      const { error } = await supabase.from(entry.table).insert(entry.row!)
      if (error) throw error
    } else if (entry.kind === 'update') {
      let query = supabase.from(entry.table).update(entry.patch!).eq('id', entry.rowId)
      if (entry.expectUpdatedAt) query = query.eq('updated_at', entry.expectUpdatedAt)
      const { data, error } = await query.select()
      if (error) throw error

      if ((data ?? []).length === 0) {
        /*
         * 0 行。楽観ロックを掛けていたなら、相手が先に変えたということ。
         * 上書きも破棄もしない——長くオフラインだった後はたいてい相手が進んでいるし、
         * どちらを黙って選んでも誰かの書いたものが消える。送信箱で選ばせる。
         */
        if (entry.expectUpdatedAt) {
          const { data: latest } = await supabase
            .from(entry.table)
            .select('*')
            .eq('id', entry.rowId)
            .maybeSingle()
          const server = latest as Record<string, unknown> | null
          await updateEntry(entry.key, {
            state: 'failed',
            reason: 'conflict',
            errorText: '他の人が先に書き換えました。',
            serverText: String(server?.text ?? server?.title ?? server?.body ?? ''),
          })
          return false
        }
        // ロックを掛けていないのに 0 行なら、RLS の USING で弾かれている
        throw { code: '42501', message: '書き込む権限がありません' }
      }
    } else {
      const { error } = await supabase
        .from(entry.table)
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', entry.rowId)
      if (error) throw error
    }

    await dropEntry(entry.key)
    return true
  } catch (e) {
    const result = classifyError(e)

    if (result.outcome === 'success') {
      // 前回の送信が実は通っていた。ここで捨てないと永久に残る
      await dropEntry(entry.key)
      return true
    }

    if (result.outcome === 'retry') {
      const attempts = entry.attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        await updateEntry(entry.key, {
          state: 'failed',
          attempts,
          reason: 'unknown',
          errorText: '何度か試しましたが送れませんでした。',
        })
        return false
      }
      await updateEntry(entry.key, {
        state: 'pending',
        attempts,
        nextAttemptAt: Date.now() + nextBackoff(entry.attempts),
      })
      return false
    }

    await updateEntry(entry.key, {
      state: 'failed',
      reason: result.reason,
      errorText: result.errorText,
    })
    return false
  }
}

/**
 * ためた書き込みを送る。
 *
 * 1 タブだけが走るように錠を取る。取れない環境でもそのまま走らせてよい——
 * 主キーの重複を成功として扱っているので、二重に送っても壊れない。
 */
async function flush(userId: string): Promise<void> {
  await withFlushLock(async () => {
    const now = Date.now()
    const ready = outboxSnapshot().filter(
      (entry) => entry.state !== 'failed' && (entry.nextAttemptAt ?? 0) <= now,
    )
    if (ready.length === 0) return

    /*
     * 送れなかった親を覚えておく。子（source_note_id などで親を指す行）は
     * そのつながりだけ外して送る。やることの文字が残るほうが、
     * 「この付箋から生まれました」より大事。
     */
    const missing = new Set<string>()

    for (const entry of orderForFlush(ready)) {
      const target =
        entry.kind === 'create' && entry.row
          ? { ...entry, row: nullOrphanRefs(entry.row, missing) }
          : entry

      const ok = await send(target, userId)
      if (!ok) missing.add(entry.rowId)
    }
  })
}

/**
 * 送信箱を動かす。ボードを開いているあいだ 1 つだけ動かす。
 *
 * オンラインに戻ったとき・タブが表に戻ったとき・送信箱が変わったときに送る。
 * 待ち時間つきで残っているものがあるときだけ、様子見の間隔でも起こす。
 */
export function useWriteQueue(userId: string) {
  useEffect(() => {
    if (!userId) return
    let stopped = false

    const run = () => {
      if (stopped) return
      void flush(userId)
    }

    const onOnline = () => run()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run()
    }

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)

    // 自分のタブでためたとき、他のタブが書き換えたとき
    const stopStore = subscribeOutbox(run)
    const stopChannel = onAnnounce(() => void reloadOutbox())

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (outboxSnapshot().some((entry) => entry.state !== 'failed')) run()
    }, TICK_MS)

    run()

    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
      stopStore()
      stopChannel()
    }
  }, [userId])
}
