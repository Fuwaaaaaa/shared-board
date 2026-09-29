import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) =>
  readFileSync(new URL(`../../../supabase/${name}`, import.meta.url), 'utf8')

/** 空のボードかどうかに関わらない表。あっても「中身がある」とは数えない */
const NOT_CONTENT: Record<string, string> = {
  room_secrets: 'ボードの設定',
  room_members: '参加者',
  activities: '最後に動いた日として、別に見ている',
  notifications: '通知',
  access_attempts: '合言葉の失敗の記録',
}

describe('cleanup-empty-rooms（cron.sql）', () => {
  /*
   * 週 1 回、中身が無く 30 日動いていないボードを消す。
   * 中身の表を 1 つでも見落とすと、その表にしか中身が無いボードが丸ごと消える
   * （以前は外部カレンダーと保存した状態を見ておらず、外部カレンダーを重ねて見るだけの
   * ボードが、作って 30 日で消えていた）。
   */
  it('ボードの中身になる表を、どれも見てから消す', () => {
    const tables = new Map<string, string>()
    for (const m of read('schema.sql').matchAll(
      /create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g,
    )) {
      tables.set(m[1], m[2])
    }
    const roomTables = [...tables].filter(([, body]) =>
      /room_id\s+uuid not null references public\.rooms\(id\)/.test(body),
    )
    expect(roomTables.length, 'schema.sql からボードの表を読めていません').toBeGreaterThan(20)

    const job = /'cleanup-empty-rooms',[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(read('cron.sql'))
    expect(job, 'cleanup-empty-rooms のジョブが見つかりません').not.toBeNull()
    const checked = new Set(
      [...job![1].matchAll(/not exists \(select 1 from public\.(\w+)\s+x where x\.room_id = r\.id\)/g)].map(
        (m) => m[1],
      ),
    )
    expect(checked.has('notes'), 'ジョブの条件を読めていません').toBe(true)

    // 👍 や出欠のように親の表と一緒に消える表は、親を見ていれば足りる
    const parentChecked = (body: string) =>
      [...body.matchAll(/references public\.(\w+)\(id\) on delete cascade/g)].some(
        (m) => m[1] !== 'rooms' && checked.has(m[1]),
      )

    const unchecked = roomTables
      .filter(([name, body]) => !checked.has(name) && !(name in NOT_CONTENT) && !parentChecked(body))
      .map(([name]) => name)
    expect(unchecked).toEqual([])
  })
})
