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
/**
 * IndexedDB は開けているのに、書けなかった分。ページを閉じると消える。
 *
 * 以前は 1 回書けないと memory に切り替えていたので、そのあとは IndexedDB にある分を
 * 読まなくなり、新しく入れた分もメモリにしか置かなかった。書けなかった分だけをここに持ち、
 * 読むときは IndexedDB の分と合わせる。
 */
const unsaved = new Map<string, QueueEntry>()
let channel: BroadcastChannel | null = null

/**
 * ためた分がすべて端末に残っているか。
 * 1 件でも書けなかった分があるあいだは false（タブを閉じると消えるものがある、と画面に出す）。
 */
export function isPersistent(): boolean {
  return db !== null && unsaved.size === 0
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

/**
 * 書き込みを 1 つのトランザクションで行い、確定（oncomplete）まで待つ。
 *
 * 要求の onsuccess で済ませると、容量不足で取り消されても書けたことになる。
 * QuotaExceededError は要求ではなく、コミットのときにトランザクションの取り消しとして出る。
 */
function write(run: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) throw new Error('IndexedDB is not available')
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error)
    run(transaction.objectStore(STORE))
  })
}

export async function readAll(): Promise<QueueEntry[]> {
  if (memory) return [...memory.values()]
  if (!db) return [...unsaved.values()]

  let stored: QueueEntry[] = []
  try {
    stored = await request<QueueEntry[]>(() => tx('readonly').getAll() as IDBRequest<QueueEntry[]>)
  } catch {
    stored = []
  }
  // 書けなかった分は、IndexedDB に残っている同じ key の版より新しい
  const byKey = new Map(stored.map((entry) => [entry.key, entry]))
  for (const [key, entry] of unsaved) byKey.set(key, entry)
  return [...byKey.values()]
}

export async function put(entry: QueueEntry): Promise<void> {
  if (memory) {
    memory.set(entry.key, entry)
    return
  }
  if (!db) return
  try {
    await write((store) => store.put(entry))
    unsaved.delete(entry.key)
  } catch {
    // 置けなかったら、せめてメモリに残す（このタブが開いているあいだは拾える）
    unsaved.set(entry.key, entry)
  }
}

export async function remove(key: string): Promise<void> {
  if (memory) {
    memory.delete(key)
    return
  }
  unsaved.delete(key)
  if (!db) return
  try {
    await write((store) => store.delete(key))
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
