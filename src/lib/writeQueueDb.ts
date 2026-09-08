/*
 * 送信箱の置き場。IndexedDB に持ち、タブをまたいで 1 つだけにする。
 *
 * localStorage にしない理由:
 *   同期 API で、5MB を既存の board.* キーと分け合う。5,000 字上限の付箋を
 *   60 枚ためれば 300KB。QuotaExceededError は、この機能が防ぐべきまさにその失敗。
 *
 * Service Worker の Background Sync にしない理由:
 *   RLS 前提のリクエストを supabase-js の外で組み直すことになり、
 *   Safari と Firefox では動かない。しかも usePwa は dev で SW を登録しないので、
 *   npm run dev でも Playwright でも動きを確かめられない。
 *
 * 使えない環境（プライベートウィンドウなど）ではメモリに置き、そのことを正直に出す。
 */

import type { QueueEntry } from './writeQueue'

const DB_NAME = 'board-outbox'
const DB_VERSION = 1
const STORE = 'entries'

/** タブをまたいで「変わった」を知らせるチャンネル */
const CHANNEL = 'board.outbox'
/** 同時に送るのを 1 タブに絞るための錠 */
const LOCK = 'board.outbox.flush'

let db: IDBDatabase | null = null
/** IndexedDB が使えないときの置き場。ページを閉じると消える */
let memory: Map<string, QueueEntry> | null = null
let channel: BroadcastChannel | null = null

/** IndexedDB が使えているか。使えていなければ、その旨を画面に出す */
export function isPersistent(): boolean {
  return db !== null
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const upgraded = request.result
      if (!upgraded.objectStoreNames.contains(STORE)) {
        upgraded.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 立ち上げ時に 1 回。失敗してもメモリに落として続ける */
export async function openQueue(): Promise<void> {
  if (db || memory) return
  try {
    db = await open()
  } catch {
    db = null
    memory = new Map()
  }

  try {
    channel = new BroadcastChannel(CHANNEL)
  } catch {
    channel = null
  }
}

function tx(mode: IDBTransactionMode): IDBObjectStore {
  if (!db) throw new Error('IndexedDB is not available')
  return db.transaction(STORE, mode).objectStore(STORE)
}

function request<T>(make: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = make()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function readAll(): Promise<QueueEntry[]> {
  if (memory) return [...memory.values()]
  if (!db) return []
  try {
    return await request<QueueEntry[]>(() => tx('readonly').getAll() as IDBRequest<QueueEntry[]>)
  } catch {
    return []
  }
}

export async function put(entry: QueueEntry): Promise<void> {
  if (memory) {
    memory.set(entry.key, entry)
    return
  }
  if (!db) return
  try {
    await request(() => tx('readwrite').put(entry))
  } catch {
    // 置けなかったら、せめてメモリに残す（このタブが開いているあいだは拾える）
    memory = memory ?? new Map()
    memory.set(entry.key, entry)
  }
}

export async function remove(key: string): Promise<void> {
  if (memory) memory.delete(key)
  if (!db) return
  try {
    await request(() => tx('readwrite').delete(key))
  } catch {
    // 消せなくても、次の読み込みで拾い直せる
  }
}

/** 他のタブに「変わった」と伝える */
export function announce(): void {
  try {
    channel?.postMessage('changed')
  } catch {
    // 伝えられなくても、送るのは自分のタブでもできる
  }
}

export function onAnnounce(listener: () => void): () => void {
  if (!channel) return () => {}
  const handler = () => listener()
  channel.addEventListener('message', handler)
  return () => channel?.removeEventListener('message', handler)
}

/**
 * 送るのを 1 タブに絞る。
 *
 * 錠が使えない環境では、絞らずにそのまま走らせる。
 * 二重に送っても、主キーの重複を成功として扱っているので壊れない
 * （writeQueue.classifyError）。その冪等性は、ここのために譲れない。
 */
export async function withFlushLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = (navigator as unknown as { locks?: LockManager }).locks
  if (!locks) return run()
  return locks.request(LOCK, run) as Promise<T>
}
