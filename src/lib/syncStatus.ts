import { useSyncExternalStore } from 'react'

/**
 * 「いま保存できているか」をまとめて持つ小さなストア。
 *
 * 書き込みはタブごとの処理に散らばっているので、1 件ずつ状態を持たせるのは現実的でない。
 * 代わりに Supabase への HTTP リクエスト（lib/supabase.ts の trackedFetch）を数えて、
 *
 *   保存済み  … 送るものが残っていない
 *   同期中    … 送信中のものがある
 *   オフライン … つながっていない
 *   エラー    … 送ったが断られた
 *
 * の 4 つだけを表に出す。共同編集では「自分の書いたものが相手に届いたか」が
 * いちばん不安になるところなので、そこだけをはっきりさせる。
 */
export type SyncState = 'saved' | 'saving' | 'offline' | 'error'

let pending = 0
let failed = false
let offline = typeof navigator === 'undefined' ? false : !navigator.onLine
let snapshot: SyncState = 'saved'

const listeners = new Set<() => void>()

function compute(): SyncState {
  if (offline) return 'offline'
  if (pending > 0) return 'saving'
  if (failed) return 'error'
  return 'saved'
}

function publish() {
  const next = compute()
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    offline = false
    publish()
  })
  window.addEventListener('offline', () => {
    offline = true
    publish()
  })
}

/** 書き込みリクエストの開始 */
export function beginWrite() {
  pending += 1
  publish()
}

/** 書き込みリクエストの終了。ok が false なら「保存できませんでした」を出す */
export function endWrite(ok: boolean) {
  pending = Math.max(0, pending - 1)
  if (ok) failed = false
  else failed = true
  publish()
}

/** エラー表示を消す（画面から「再読み込み」などを促したあと） */
export function clearSyncError() {
  failed = false
  publish()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * いまの状態。画面は useSyncStatus を使う。
 * こちらは React の外（テストなど）から覗くとき用。
 */
export function syncSnapshot(): SyncState {
  return snapshot
}

function getSnapshot(): SyncState {
  return syncSnapshot()
}

export function useSyncStatus(): SyncState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export const SYNC_LABELS: Record<SyncState, { icon: string; label: string; title: string }> = {
  saved: {
    icon: '✓',
    label: '保存済み',
    title: '書いたものはみんなに届いています。送信待ちのものもありません',
  },
  saving: { icon: '↻', label: '同期中', title: '保存しています' },
  offline: {
    icon: '⚠',
    label: 'オフライン',
    title: 'つながっていません。書いたものは手元にためて、つながったら送ります',
  },
  error: {
    icon: '⚠',
    label: '保存できません',
    title: '保存に失敗しました。ページを読み込み直してください',
  },
}
