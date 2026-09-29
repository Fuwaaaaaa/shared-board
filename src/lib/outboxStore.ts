/*
 * 送信箱の中身を持つ、React の外のストア（cursorStore と同じ作り）。
 *
 * useRealtimeTable のオーバーレイと、ヘッダーのピルと、送信箱のモーダルが
 * それぞれ購読する。React の state に置くと、1 件ためるたびに
 * ボード全体が描き直されるので外に出してある。
 */

import { useSyncExternalStore } from 'react'
import {
  afterSend,
  collapse,
  keyOf,
  tooLargeToQueue,
  type QueueEntry,
  type QueueOp,
  type QueueTable,
} from './writeQueue'
import { announce, isPersistent, openQueue, put, readAll, remove } from './writeQueueDb'

let entries: QueueEntry[] = []
let ready = false
let seq = 0

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React の外から購読する（useRealtimeTable のオーバーレイ用） */
export const subscribeOutbox = subscribe

function snapshot(): QueueEntry[] {
  return entries
}

/** React の外から覗くとき用（テストなど） */
export function outboxSnapshot(): QueueEntry[] {
  return entries
}

export function outboxReady(): boolean {
  return ready
}

/**
 * 立ち上げ時に 1 回だけ。
 *
 * これを済ませる前にボードを描き始めると、最初の refetch が
 * ためてあった行を「サーバーが知らない行」として消してしまう。
 * RoomPage の読み込みゲートがこの完了を待つ。
 */
export async function loadOutbox(): Promise<void> {
  if (ready) return
  await openQueue()
  entries = await readAll()
  syncSeq()
  ready = true
  emit()
}

/**
 * ためた順の通し番号を、いま持っている中身に合わせる。
 *
 * 他のタブが先に進めていることがあるので、読み直したときも見る。見ないでいると、
 * こちらが後から書いたものに小さい番号が付き、orderForFlush が「先に書いたもの」
 * として先に送ってしまう。減らさないのは、送り終えて消えた番号を配り直さないため。
 */
function syncSeq(): void {
  seq = entries.reduce((max, entry) => Math.max(max, entry.seq), seq)
}

/** 他のタブが書き換えたときに読み直す */
export async function reloadOutbox(): Promise<void> {
  entries = await readAll()
  syncSeq()
  emit()
}

export function nextSeq(): number {
  seq += 1
  return seq
}

/**
 * 1 件ためる。
 *
 * 同じ行の分があれば畳む（作って消したものも、消す指示の 1 件として残る）。
 * 大きすぎるものは、ためずに false を返す——黙って落とすと
 * 「書いたのに消えた」がいちばん困る形で起きる。
 */
export async function enqueue(op: QueueOp): Promise<boolean> {
  const key = keyOf(op.roomId, op.table, op.rowId)
  const existing = entries.find((entry) => entry.key === key)
  const next = collapse(existing, op)

  if (tooLargeToQueue(next)) return false

  entries = [...entries.filter((entry) => entry.key !== key), next]
  await put(next)
  announce()
  emit()
  return true
}

/**
 * その行の分が送信箱に残っているか（作成・書き換え・削除のどれでも）。
 *
 * 残っているあいだ、同じ行への次の書き込みはサーバーへ直接送らず、その後ろに並べる。
 * 追い越すと、まだ届いていない作成に UPDATE / DELETE が先に当たって 0 行で終わる。
 */
export function hasEntry(roomId: string, table: QueueTable, rowId: string): boolean {
  const key = keyOf(roomId, table, rowId)
  return entries.some((entry) => entry.key === key)
}

/** 送れた・捨てたので、送信箱から外す */
export async function dropEntry(key: string): Promise<void> {
  entries = entries.filter((entry) => entry.key !== key)
  await remove(key)
  announce()
  emit()
}

/**
 * 送れたので片付ける。
 *
 * 送っているあいだに同じ行へ書き足されていたら、消さずに送り直す側へ回す
 * （判断は writeQueue.afterSend）。key だけで消すと、その書き足しごと消える。
 * alreadyExisted は、作成が主キーの重複で返ってきたとき。
 * serverUpdatedAt は、送れた更新のあとの updated_at（送り直すときのロックになる）。
 */
export async function settleSent(
  key: string,
  sentRev: number,
  alreadyExisted = false,
  serverUpdatedAt?: string,
): Promise<void> {
  const current = entries.find((entry) => entry.key === key)
  if (!current) return

  const next = afterSend(current, sentRev, alreadyExisted, serverUpdatedAt)
  if (next === 'drop') {
    await dropEntry(key)
    return
  }
  await updateEntry(key, next)
}

/** 状態だけを書き換える（送信中・失敗・次に試す時刻） */
export async function updateEntry(key: string, patch: Partial<QueueEntry>): Promise<void> {
  const current = entries.find((entry) => entry.key === key)
  if (!current) return
  const next = { ...current, ...patch }
  entries = entries.map((entry) => (entry.key === key ? next : entry))
  await put(next)
  announce()
  emit()
}

export function entriesFor(roomId: string, table: QueueTable): QueueEntry[] {
  return entries.filter((entry) => entry.roomId === roomId && entry.table === table)
}

export function useOutboxEntries(): QueueEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

const readySnapshot = () => ready

/** 送信箱の読み込みが済んだか。済むまでボードを描き始めない */
export function useOutboxReady(): boolean {
  return useSyncExternalStore(subscribe, readySnapshot, readySnapshot)
}

export interface OutboxCounts {
  pending: number
  failed: number
  /** IndexedDB が使えているか。使えていなければ、そのことを画面に出す */
  persistent: boolean
  /** 別のボードにためたままのもの。数えるボードを絞ったときだけ 0 より大きくなる */
  elsewhere: number
}

/**
 * 送信箱の件数。
 *
 * roomId を渡すと、そのボードのぶんだけ数える。送信箱は端末にひとつで
 * 全ボード分が同じ場所に入るので、絞らないと「別のボードの未送信」が
 * 今のボードのヘッダーに出てしまい、探しても見つからない件数になる。
 *
 * 絞ったぶんは elsewhere に残す。黙って隠すと、別のボードにためたものが
 * あることに永久に気づけなくなる。
 */
export function useOutbox(roomId?: string): OutboxCounts {
  const rows = useOutboxEntries()
  const mine = roomId ? rows.filter((entry) => entry.roomId === roomId) : rows
  return {
    pending: mine.filter((entry) => entry.state !== 'failed').length,
    failed: mine.filter((entry) => entry.state === 'failed').length,
    persistent: isPersistent(),
    elsewhere: rows.length - mine.length,
  }
}
