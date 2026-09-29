/*
 * 繰り返し予定の「この回だけ」（event_overrides）の 1 行を、どう書き込むか。
 *
 * event_overrides の author_id は UPDATE で変えられない（supabase/schema.sql の
 * tg_freeze_columns）。以前は既存の行があっても author_id を自分にして upsert して
 * いたので、他の人が作った回を変えると DB に断られ、その回は作った本人にしか
 * 変えられなかった。既存の行があれば、作った人の列には触れずにその行を更新する。
 */

import type { EventOverride } from './types'

/** この回の中身。更新ではこれだけを送る */
export type OverrideFields = Pick<
  EventOverride,
  | 'canceled'
  | 'title'
  | 'description'
  | 'start_at'
  | 'end_at'
  | 'all_day'
  | 'color'
  | 'remind_minutes'
  | 'tags'
>

export type OverrideWrite =
  | { kind: 'insert'; row: EventOverride }
  | { kind: 'update'; id: string; fields: OverrideFields }

/**
 * 行から、この回の中身だけを取り出す。
 * 指定しなかった項目も null のまま送る（元の予定のとおりに戻す、という意味になる）。
 */
export function overrideFields(row: EventOverride): OverrideFields {
  const { canceled, title, description, start_at, end_at, all_day, color, remind_minutes, tags } =
    row
  return { canceled, title, description, start_at, end_at, all_day, color, remind_minutes, tags }
}

export function overrideWrite(existing: EventOverride | undefined, row: EventOverride): OverrideWrite {
  if (!existing) return { kind: 'insert', row }
  return { kind: 'update', id: existing.id, fields: overrideFields(row) }
}
