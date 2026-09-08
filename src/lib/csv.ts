import { fromBoardParts, toBoardParts } from './dates'

/**
 * CSV の読み書き。
 *
 * Excel で開けるよう、書き出しには BOM を付け、改行は CRLF にする。
 *
 * 数式の注入（CSV injection）対策:
 *   Excel や Google スプレッドシートは、セルが = + - @ で始まると数式として評価する
 *   （タブ・CR で始まるものも同じ扱いになる版がある）。付箋の本文に「=cmd|...」のような
 *   文字列を書かれると、書き出した CSV を開いた人の環境で実行されかねない。
 *   そこで、その文字で始まる文字列には先頭に ' を付けて書き出す（表計算ソフトは ' を
 *   「これは文字列」の印として表示しない）。
 *   読み込むときは、' の直後がその文字のときだけ ' を剥がして元に戻す。
 *   副作用として「'-気になる」のように本来 ' で始まり、次が - などの値も剥がれる。
 *   そういう値は珍しいので、安全側に倒している。
 */

/** 表計算ソフトが数式として解釈しはじめる先頭文字 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

export function toCsv(headers: string[], rows: (string | number | boolean | null)[][]): string {
  const escape = (value: string | number | boolean | null): string => {
    if (value === null || value === undefined) return ''
    let text = String(value)
    // 数値・真偽値はそのまま。文字列で数式に見えるものだけ ' を前置する
    if (typeof value === 'string' && FORMULA_LEAD.test(text)) text = `'${text}`
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const lines = [headers.map(escape).join(',')]
  for (const row of rows) lines.push(row.map(escape).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** toCsv が付けた保護用の ' を剥がす（' の直後が数式の先頭文字のときだけ） */
function unprotect(field: string): string {
  return field.length >= 2 && field[0] === "'" && FORMULA_LEAD.test(field.slice(1))
    ? field.slice(1)
    : field
}

/** 引用符とその中の改行に対応した CSV パーサ */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(unprotect(field))
    field = ''
  }

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]

    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      pushField()
    } else if (char === '\r') {
      // CRLF の CR は読み飛ばす
    } else if (char === '\n') {
      pushField()
      rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (field !== '' || row.length > 0) {
    pushField()
    rows.push(row)
  }

  // 完全に空の行は落とす
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** ヘッダー行をキーにしたオブジェクトの配列にする */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []

  const headers = rows[0].map((h) => h.trim())
  return rows.slice(1).map((row) => {
    const item: Record<string, string> = {}
    headers.forEach((header, index) => {
      item[header] = (row[index] ?? '').trim()
    })
    return item
  })
}

/**
 * 「2026-09-01 10:00」「2026/9/1」「2026-09-01T10:00:00Z」などを受け取る。
 * 解釈できなければ null。
 */
export function parseFlexibleDate(value: string): Date | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(trimmed)
  if (match) {
    const [, y, m, d, hh, mm] = match
    // ボードの暦（Asia/Tokyo）として読む。new Date(y, m, d) だと実行環境の
    // タイムゾーンで解釈され、海外から取り込むと日付がずれる。
    // アプリの他の日付計算はすべて JST 固定なので、ここだけ例外にしない
    return fromBoardParts({
      y: Number(y),
      m: Number(m),
      d: Number(d),
      hh: Number(hh ?? 0),
      mm: Number(mm ?? 0),
    })
  }

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * ボードの暦での 'yyyy-MM-dd HH:mm'。書き出しに使う。
 * date-fns の format は実行環境のタイムゾーンで出るので使わない。
 */
export function boardDateTimeText(iso: string): string {
  const p = toBoardParts(new Date(iso))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`
}

/**
 * 読み込んだ文字列が化けていないか。
 *
 * file.text() は常に UTF-8 として読む。Shift_JIS の CSV を渡されると
 * 日本語が U+FFFD（置換文字）になるが、英語のヘッダーだと列の対応は取れてしまい、
 * 化けた本文がそのまま保存される。判定して止めるほうが、黙って壊すよりよい。
 * 文字コードの自動判定はしない（外れることがあり、外れ方が予測できない）。
 */
export function looksMojibake(text: string): boolean {
  return text.includes(String.fromCharCode(0xfffd))
}

/*
 * 繰り返しの曜日指定を CSV に載せる。
 *
 * 載せないと、書き出して取り込み直しただけで「毎週 火・木」が
 * 「毎週（開始日の曜日）」に化ける。予定が黙って変わるのがいちばん困る。
 */

const CSV_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** 曜日の並びを「火・木」にする。空なら空文字 */
export function formatWeekdays(days: number[]): string {
  return days
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .map((d) => CSV_WEEKDAYS[d])
    .join('・')
}

/**
 * 「火・木」「火,木」「TU,TH」を曜日の番号にする。
 * 読めない語は落とす。並べ替えと重複除去は normalizeRule に任せる。
 */
export function parseWeekdays(value: string | undefined): number[] {
  const text = (value ?? '').trim()
  if (!text) return []

  const en = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']
  const days: number[] = []
  for (const raw of text.split(/[・,、\s]+/)) {
    const token = raw.trim()
    if (!token) continue
    const jp = CSV_WEEKDAYS.indexOf(token.replace(/曜日?$/, ''))
    if (jp >= 0) {
      days.push(jp)
      continue
    }
    const idx = en.indexOf(token.slice(0, 2).toLowerCase())
    if (idx >= 0) days.push(idx)
  }
  return days
}

/** 「第2」「2」「最終」「-1」を第 n 週の番号にする。読めなければ null */
export function parseWeekOrdinal(value: string | undefined): number | null {
  const text = (value ?? '').trim()
  if (!text) return null
  if (/^(最終|最後|last|-1)$/i.test(text)) return -1

  const match = /^第?(-?\d+)/.exec(text)
  if (!match) return null
  const n = Number(match[1])
  if (n === -1) return -1
  return n >= 1 && n <= 5 ? n : null
}
