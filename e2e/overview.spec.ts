import { expect, test } from '@playwright/test'
import { createBoard, signIn, waitForSaved } from './helpers'

/*
 * ホームの「自分の番」。
 *
 * ボードを開かないと自分の担当が見えない、というのがこれまでの弱点だった。
 * 区切り（期限切れ / 今日 / 今週）の境目は純粋関数のテストが見ているので、
 * ここで見たいのはつなぎ目のほう——ボードを跨いで拾えるか、押した先が
 * 正しいボードの正しいタブか。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E ${Date.now().toString(36)}`

/** きょうの日付を <input type="date"> に入れる形で */
function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

test('自分の担当が、ホームからボードを跨いで見える', async ({ page }) => {
  await signIn(page, 'ひとり目')
  const boardName = stamp()
  await createBoard(page, boardName)

  // リマインドを 1 件。自分を担当にして、期限を今日にする
  await page.getByRole('button', { name: 'リマインド' }).click()
  await page.getByPlaceholder('やること・忘れたくないことを入力').fill('会場に電話する')
  await page.keyboard.press('Enter')
  await expect(page.getByText('会場に電話する')).toBeVisible()
  await waitForSaved(page)

  await page.getByText('会場に電話する').click()
  // ラベルは入力と結びついていないので、種類で掴む
  await page.locator('input[type="date"]').fill(today())
  await page.locator('input[type="time"]').fill('23:30')
  await page
    .locator('select')
    .filter({ has: page.locator('option', { hasText: '未割り当て' }) })
    .selectOption({ label: 'ひとり目' })
  await page.getByRole('button', { name: '保存' }).click()
  await waitForSaved(page)

  // ホームへ戻ると、ボードを開かなくても出ている
  await page.goto('/')
  const overview = page.locator('section', { has: page.getByRole('heading', { name: '自分の番' }) })
  await expect(overview).toBeVisible()
  await expect(overview.getByText('会場に電話する')).toBeVisible()
  // どのボードのことか分からないと、押す前に迷う
  await expect(overview.getByText(boardName)).toBeVisible()

  // 押すと、そのボードのリマインドタブが開く
  await overview.getByText('会場に電話する').click()
  await expect(page).toHaveURL(/\/r\/[0-9a-z]+/)
  await expect(page.getByText('会場に電話する')).toBeVisible()

  // 合図は URL に残さない（残すと、タブを切り替えても引き戻される）
  await expect(page).not.toHaveURL(/focus=/)
})

test('担当でないやることは、ホームに出ない', async ({ page }) => {
  /*
   * 「自分の番」なので、担当が決まっていないものまで出すと
   * ボードの中のリマインドタブと変わらなくなる。
   */
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  await page.getByRole('button', { name: 'リマインド' }).click()
  await page.getByPlaceholder('やること・忘れたくないことを入力').fill('だれかが決める')
  await page.keyboard.press('Enter')
  await expect(page.getByText('だれかが決める')).toBeVisible()

  // 期限だけ入れて、担当は空のまま
  await page.getByText('だれかが決める').click()
  await page.locator('input[type="date"]').fill(today())
  await page.getByRole('button', { name: '保存' }).click()
  await waitForSaved(page)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '新しいボードを作る' })).toBeVisible()
  await expect(page.getByText('だれかが決める')).toHaveCount(0)
})


test('窓の先から前倒しした回も、ホームに出る', async ({ page }) => {
  /*
   * 3 週間後に始まる系列の回を「この回だけ」で 2 日後へ動かす。
   *
   * この形は単体テストでは守れない。展開（expandOccurrences）は前から手当てして
   * いるが、取ってくる側の絞り込みで元の行を先に落とすと、そこまで届かない
   * ——実際、最初の実装は start_at を窓で切っていて落としていた。
   * 絞り込みは PostgREST に渡す文字列なので、確かめられるのはここだけ。
   *
   * 仕込みに psql を使うのは、「この回だけ」の移動を画面から作ると
   * カレンダーのドラッグに依存して、見たいところから遠くなるため。
   * コンテナ名は .github/workflows/ci.yml が立てるものと同じ。
   */
  const { execFileSync } = await import('node:child_process')
  const psql = (sql: string) =>
    execFileSync(
      'docker',
      // -q が無いと、returning の値のうしろに INSERT 0 1 が付いてくる
      ['exec', '-i', 'supabase_db_shared-board', 'psql', '-qAt', '-U', 'postgres', '-d', 'postgres', '-c', sql],
      { encoding: 'utf8' },
    ).trim()

  const iso = (dayOffset: number, hhmm: string) => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    const [h, m] = hhmm.split(':').map(Number)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }

  await signIn(page, 'ひとり目')
  const boardName = stamp()
  await createBoard(page, boardName)

  const room = psql(`select id from public.rooms where name = '${boardName}'`)
  const me = psql(`select owner_id from public.rooms where id = '${room}'`)

  // id は毎回作る。固定にすると、2 回目の実行が前回の行とぶつかって
  // 「入らなかったのに気づけない」状態になる
  const eventId = psql(`
    insert into public.events (room_id, title, start_at, end_at, all_day, recurrence, author_id, author_name)
    values ('${room}', '前倒しの点検',
            '${iso(21, '10:00')}', '${iso(21, '11:00')}', false, 'weekly', '${me}', 'ひとり目')
    returning id;
  `)

  // 元の回（21 日後）を 2 日後へ動かす
  psql(`
    insert into public.event_overrides (room_id, event_id, occurrence_date, title, start_at, end_at, author_id)
    values ('${room}', '${eventId}',
            (timestamptz '${iso(21, '10:00')}' at time zone 'Asia/Tokyo')::date,
            '前倒しの点検', '${iso(2, '14:00')}', '${iso(2, '15:00')}', '${me}');
  `)

  await page.goto('/')
  const overview = page.locator('section', { has: page.getByRole('heading', { name: '自分の番' }) })
  await expect(overview).toBeVisible()
  await expect(overview.getByText('前倒しの点検')).toBeVisible()
  await expect(overview.getByText(boardName)).toBeVisible()
})
