/**
 * 付箋のコピー＆貼り付け。
 *
 * システムのクリップボードは「読み出し」がブラウザごとにばらばらで、
 * Firefox はページからの navigator.clipboard.readText() を許さないし、
 * Chrome は権限のダイアログを出す。LAN 公開（VITE_LAN=1）は http なので
 * secure context ですらなく、navigator.clipboard 自体が undefined になる。
 *
 * そこで「アプリの中のクリップボード」を正とし、システム側へは
 * copy / cut イベントで本文を書き出すだけにしてある（こちらは権限も要らず、
 * どのブラウザでも動く）。他のアプリへ貼れるのはテキスト、
 * このアプリの中では色や大きさも保たれる、という切り分け。
 */

import { NOTE_COLORS, type Note } from './types'
import { clampFontSize } from './noteFont'

/** createNotesFromText と同じ上限。巨大な貼り付けでボードと DB を潰さない */
const MAX_NOTES = 60
const MAX_TEXT = 1000

let notes: Note[] = []
let style: string | null = null

export function setClipboardNotes(rows: Note[]): void {
  notes = rows.slice(0, MAX_NOTES).map((note) => ({ ...note }))
}

export function getClipboardNotes(): Note[] {
  return notes
}

export function clipboardCount(): number {
  return notes.length
}

export function setClipboardStyle(color: string): void {
  style = color
}

export function getClipboardStyle(): string | null {
  return style
}

/** 他のアプリへ渡すときの中身。付箋の本文を改行でつないだもの */
export function notesToText(rows: Note[]): string {
  return rows.map((note) => note.text).join('\n')
}

interface PasteContext {
  roomId: string
  userId: string
  displayName: string
  /** 貼り付け先の左上。コピー元の相対配置は保つ */
  x: number
  y: number
  /** 重なり順の起点 */
  baseZ: number
  boardW: number
  boardH: number
}

/**
 * クリップボードの中身から、入れて良い付箋の配列を作る。
 *
 * 中身は自分で書いたものだが、id・部屋・作者は必ず作り直す。
 * とくに author_id は、RLS の INSERT 条件が author_id = auth.uid() なので、
 * コピー元（他の人の付箋かもしれない）のままだと 1 件も入らない。
 */
export function buildPastedNotes(source: Note[], ctx: PasteContext): Note[] {
  const rows = source.slice(0, MAX_NOTES)
  if (rows.length === 0) return []

  // まとまりの左上を貼り付け先に合わせ、相互の位置関係は保つ
  const left = Math.min(...rows.map((n) => n.x))
  const top = Math.min(...rows.map((n) => n.y))
  const now = new Date().toISOString()

  return rows.map((note, i) => {
    const w = clamp(note.w, 40, ctx.boardW)
    const h = clamp(note.h, 40, ctx.boardH)
    return {
      id: crypto.randomUUID(),
      room_id: ctx.roomId,
      kind: note.kind === 'text' ? 'text' : 'sticky',
      x: clamp(ctx.x + (note.x - left), 0, ctx.boardW - w),
      y: clamp(ctx.y + (note.y - top), 0, ctx.boardH - h),
      w,
      h,
      color: note.color in NOTE_COLORS ? note.color : 'yellow',
      text: cleanText(note.text),
      tags: Array.isArray(note.tags) ? note.tags.filter((t) => typeof t === 'string') : [],
      // 文字サイズは引き継ぐ。0（既定のまま）はそのまま 0 で残す
      font_size:
        Number.isFinite(note.font_size) && note.font_size > 0 ? clampFontSize(note.font_size) : 0,
      z: ctx.baseZ + 1 + i,
      deleted_at: null,
      author_id: ctx.userId,
      author_name: ctx.displayName,
      created_at: now,
      updated_at: now,
    }
  })
}

/** 制御文字を落とし、改行を揃え、入力欄と同じ長さに収める */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_TEXT)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (max < min) return min
  return Math.max(min, Math.min(value, max))
}
