import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { estimatePayloadSize, isOrphanComment, missingBlobPaths, PAYLOAD_LIMIT } from '../snapshot'

describe('控える表と戻す表（schema.sql）', () => {
  /*
   * restore_snapshot は、回す表のうち控えに載っていない今の行を片付ける。
   * 控える側がどれか 1 つでも落とすと、その表は戻すたびに空になる
   * （以前は画面が 8 表しか控えておらず、👍・絵文字・日程調整・出欠が消えていた）。
   * 両方が同じ一覧（snapshot_tables）を回していれば、食い違いようがない。
   */
  it.each(['save_snapshot', 'restore_snapshot'])('%s は snapshot_tables() を回す', (name) => {
    const source = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8')
    const body = new RegExp(`function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(source)
    expect(body, `${name} が見つかりません`).not.toBeNull()
    expect(body![0]).toContain('foreach t in array public.snapshot_tables() loop')
  })
})

describe('estimatePayloadSize', () => {
  /*
   * サーバー（schema.sql の v_limits）は payload::text の文字数で弾く。
   * 押してから断られるのを避けるため、画面側でも同じ尺度で測る。
   */
  it('いちばん大きい表を教える', () => {
    const payload = {
      notes: [{ id: 'n1', text: 'あ' }],
      strokes: [{ id: 's1', points: 'x'.repeat(500) }],
      images: [],
    }
    expect(estimatePayloadSize(payload).biggest).toBe('strokes')
  })

  it('全体の大きさは、まとめて JSON にした長さ', () => {
    const payload = { notes: [{ id: 'n1' }] }
    expect(estimatePayloadSize(payload).bytes).toBe(JSON.stringify(payload).length)
  })

  it('空でも落ちない', () => {
    const size = estimatePayloadSize({})
    expect(size.bytes).toBeGreaterThan(0)
    expect(size.biggest).toBe('')
  })

  it('上限はサーバーと同じ数', () => {
    // supabase/schema.sql の v_limits にある snapshots.payload:3000000 と同じ。
    // 片方だけ変えると、画面が通したものをサーバーが弾くようになる
    expect(PAYLOAD_LIMIT).toBe(3_000_000)
  })
})

describe('missingBlobPaths', () => {
  it('Storage にもう無いものだけを返す', () => {
    const rows = [
      { storage_path: 'room/a.pdf' },
      { storage_path: 'room/b.pdf' },
      { storage_path: 'room/c.pdf' },
    ]
    expect(missingBlobPaths(rows, new Set(['room/a.pdf', 'room/c.pdf']))).toEqual(['room/b.pdf'])
  })

  it('全部あれば空', () => {
    const rows = [{ storage_path: 'room/a.pdf' }]
    expect(missingBlobPaths(rows, new Set(['room/a.pdf']))).toEqual([])
  })

  it('行が無ければ空', () => {
    expect(missingBlobPaths([], new Set())).toEqual([])
  })
})

describe('isOrphanComment', () => {
  const ids = {
    notes: new Set(['n1']),
    events: new Set(['e1']),
    todos: new Set(['t1']),
    images: new Set(['i1']),
    attachments: new Set(['f1']),
    frames: new Set(['fr1']),
  }

  it('対象がある間は宙ぶらりんではない', () => {
    expect(isOrphanComment({ target_type: 'note', target_id: 'n1' }, ids)).toBe(false)
    expect(isOrphanComment({ target_type: 'event', target_id: 'e1' }, ids)).toBe(false)
    expect(isOrphanComment({ target_type: 'todo', target_id: 't1' }, ids)).toBe(false)
  })

  it('対象がもう無ければ宙ぶらりん', () => {
    expect(isOrphanComment({ target_type: 'note', target_id: 'gone' }, ids)).toBe(true)
    expect(isOrphanComment({ target_type: 'event', target_id: 'gone' }, ids)).toBe(true)
    expect(isOrphanComment({ target_type: 'todo', target_id: 'gone' }, ids)).toBe(true)
  })

  it('チャット（board）は対象を持たないので、宙ぶらりんにならない', () => {
    expect(isOrphanComment({ target_type: 'board', target_id: null }, ids)).toBe(false)
  })

  it('対象の id が無い行も、宙ぶらりん扱いにしない', () => {
    expect(isOrphanComment({ target_type: 'note', target_id: null }, ids)).toBe(false)
  })

  it('種類ごとに別々の一覧を見る（付箋の id が予定にあっても混ざらない）', () => {
    expect(isOrphanComment({ target_type: 'event', target_id: 'n1' }, ids)).toBe(true)
  })

  it('画像・ファイル・フレームへのコメントも見る', () => {
    expect(isOrphanComment({ target_type: 'image', target_id: 'i1' }, ids)).toBe(false)
    expect(isOrphanComment({ target_type: 'file', target_id: 'f1' }, ids)).toBe(false)
    expect(isOrphanComment({ target_type: 'frame', target_id: 'fr1' }, ids)).toBe(false)

    expect(isOrphanComment({ target_type: 'image', target_id: 'gone' }, ids)).toBe(true)
    expect(isOrphanComment({ target_type: 'file', target_id: 'gone' }, ids)).toBe(true)
    expect(isOrphanComment({ target_type: 'frame', target_id: 'gone' }, ids)).toBe(true)
  })
})
