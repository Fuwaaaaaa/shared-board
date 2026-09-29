import { describe, expect, it } from 'vitest'
import { overrideFields, overrideWrite } from '../overrides'
import type { EventOverride } from '../types'

/*
 * 「この回だけ」の 1 行を、どう書き込むか。
 *
 * event_overrides の author_id は UPDATE で変えられない（tg_freeze_columns）。
 * 以前は既存の行があっても author_id を自分にして upsert していたので、他の人が作った
 * 回を変えると DB に断られ、その回は作った本人にしか変えられなかった。
 */

const row = (over: Partial<EventOverride> = {}): EventOverride => ({
  id: 'ov-1',
  room_id: 'room-1',
  event_id: 'event-1',
  occurrence_date: '2026-10-12',
  canceled: false,
  title: '定例（午後）',
  description: null,
  start_at: '2026-10-12T05:00:00.000Z',
  end_at: null,
  all_day: false,
  color: null,
  remind_minutes: null,
  tags: null,
  author_id: 'me',
  author_name: 'けいこ',
  created_at: '2026-10-01T00:00:00.000Z',
  ...over,
})

describe('overrideWrite', () => {
  it('まだ無い回は、自分が作った行として入れる', () => {
    const next = row()
    expect(overrideWrite(undefined, next)).toEqual({ kind: 'insert', row: next })
  })

  it('他の人が作った回は、作った人の列に触れずにその行を更新する', () => {
    const existing = row({ author_id: 'someone', author_name: 'ゆうき', title: '定例' })
    const write = overrideWrite(existing, row({ id: existing.id }))

    expect(write).toEqual({ kind: 'update', id: existing.id, fields: overrideFields(row()) })
    if (write.kind !== 'update') return
    for (const frozen of ['id', 'room_id', 'event_id', 'occurrence_date', 'author_id', 'author_name', 'created_at']) {
      expect(write.fields).not.toHaveProperty(frozen)
    }
  })

  it('更新でも、この回の中身はすべて送る（指定しなかった項目は元に戻す）', () => {
    expect(Object.keys(overrideFields(row())).sort()).toEqual(
      ['all_day', 'canceled', 'color', 'description', 'end_at', 'remind_minutes', 'start_at', 'tags', 'title'].sort(),
    )
  })
})
