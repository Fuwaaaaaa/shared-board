import type { NoteKind } from './types'

export interface TemplateItem {
  kind: NoteKind
  x: number
  y: number
  w: number
  h: number
  color: string
  text: string
}

export interface BoardTemplate {
  key: string
  name: string
  description: string
  items: TemplateItem[]
}

const COL_W = 560
const COL_GAP = 40
const TOP = 60

/** 見出し用のテキストボックス */
function heading(index: number, text: string): TemplateItem {
  return {
    kind: 'text',
    x: 80 + index * (COL_W + COL_GAP),
    y: TOP,
    w: COL_W,
    h: 60,
    color: 'gray',
    text,
  }
}

/** 見出しの下に置くサンプル付箋 */
function card(index: number, row: number, color: string, text: string): TemplateItem {
  return {
    kind: 'sticky',
    x: 100 + index * (COL_W + COL_GAP),
    y: TOP + 90 + row * 190,
    w: 240,
    h: 170,
    color,
    text,
  }
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    key: 'blank',
    name: '白紙',
    description: '何も置かずに始めます。',
    items: [],
  },
  {
    key: 'kpt',
    name: 'KPT ふりかえり',
    description: 'Keep（続けること）・Problem（困りごと）・Try（次に試すこと）の 3 列。',
    items: [
      heading(0, '✅ Keep — うまくいったこと'),
      heading(1, '⚠️ Problem — 困っていること'),
      heading(2, '🚀 Try — 次に試すこと'),
      card(0, 0, 'green', ''),
      card(1, 0, 'pink', ''),
      card(2, 0, 'blue', ''),
    ],
  },
  {
    key: 'kanban',
    name: 'カンバン',
    description: '未着手・進行中・完了の 3 列でタスクを動かします。',
    items: [
      heading(0, '📋 未着手'),
      heading(1, '🔨 進行中'),
      heading(2, '🎉 完了'),
      card(0, 0, 'yellow', ''),
      card(1, 0, 'blue', ''),
      card(2, 0, 'green', ''),
    ],
  },
  {
    key: 'brainstorm',
    name: 'ブレスト',
    description: 'テーマを 1 つ置いて、まわりにアイデアを貼っていきます。',
    items: [
      {
        kind: 'text',
        x: 80,
        y: 40,
        w: 900,
        h: 70,
        color: 'gray',
        text: '💡 テーマ：（ここに書く）',
      },
      card(0, 0, 'yellow', ''),
      card(0, 1, 'pink', ''),
      { ...card(1, 0, 'blue', ''), x: 380 },
      { ...card(1, 1, 'purple', ''), x: 380 },
      { ...card(2, 0, 'green', ''), x: 660 },
    ],
  },
  {
    key: 'meeting',
    name: '会議メモ',
    description: '議題・決まったこと・宿題の 3 列。',
    items: [
      heading(0, '🗒 議題'),
      heading(1, '✔️ 決まったこと'),
      heading(2, '📌 宿題（誰がいつまでに）'),
      card(0, 0, 'yellow', ''),
      card(1, 0, 'green', ''),
      card(2, 0, 'pink', ''),
    ],
  },
]
