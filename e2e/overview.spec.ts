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
