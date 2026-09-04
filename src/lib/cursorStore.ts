import { useSyncExternalStore } from 'react'

/**
 * 他の人のカーソル位置だけを持つ小さなストア。
 *
 * カーソルは毎秒 20 回近く届くので、これを usePresence の state に入れると
 * peers を受け取っている画面全体（ヘッダーやレイヤー）が毎回描き直される。
 * ここに切り離して、CursorsLayer だけが購読するようにする。
 * 通知は requestAnimationFrame で 1 フレームに 1 回にまとめる。
 */
export interface CursorPing {
  x: number
  y: number
  laser: boolean
  /** 受け取った時刻。古いものは pruneCursors で消す */
  at: number
}

export type CursorMap = Readonly<Record<string, CursorPing>>

let working: Record<string, CursorPing> = {}
let snapshot: CursorMap = {}
let dirty = false
let frame = 0

const listeners = new Set<() => void>()

function flush() {
  frame = 0
  if (!dirty) return
  dirty = false
  snapshot = { ...working }
  for (const listener of listeners) listener()
}

function schedule() {
  dirty = true
  if (frame) return
  if (typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(flush)
  } else {
    frame = 1
    setTimeout(flush, 16)
  }
}

export function setCursor(userId: string, ping: CursorPing) {
  working[userId] = ping
  schedule()
}

/** ttlMs より古いカーソルを消す */
export function pruneCursors(ttlMs: number) {
  const cutoff = Date.now() - ttlMs
  let changed = false
  for (const [userId, ping] of Object.entries(working)) {
    if (ping.at < cutoff) {
      delete working[userId]
      changed = true
    }
  }
  if (changed) schedule()
}

export function clearCursors() {
  working = {}
  schedule()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): CursorMap {
  return snapshot
}

export function useCursors(): CursorMap {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
