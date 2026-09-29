import { expect, test, type Page } from '@playwright/test'
import { createBoard, signIn } from './helpers'

/*
 * 保存に失敗したら、編集画面を閉じずに入力を残す。
 *
 * 以前は予定もリマインドも、保存の結果を見ずに画面を閉じていた。
 * 書き込みを断られる（ボードが終了した・編集の権限を外された）と、4 秒の
 * お知らせが出るだけで、長く書いた説明ごと消えていた。リマインドでは、
 * 担当になっていないのに「担当になりました」の通知まで届いていた。
 *
 * ここでは表への書き込みを 403 で断らせて、その形を作る。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E 保存失敗 ${Date.now().toString(36)}`

/** その表への書き込み（作成・更新）だけを、権限なしで断らせる */
async function refuseWrites(page: Page, table: string) {
  await page.route(`**/rest/v1/${table}*`, (route) => {
    const method = route.request().method()
    if (method !== 'POST' && method !== 'PATCH') return route.continue()
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: '42501', message: `permission denied for table ${table}` }),
    })
  })
}

test('予定の保存に失敗したら、画面を閉じずに入力を残す', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await page.getByRole('button', { name: 'カレンダー' }).click()
  await expect(page.getByRole('button', { name: '今日' })).toBeVisible()

  await page.getByRole('button', { name: '予定を追加' }).click()
  await page.getByPlaceholder('予定のタイトル').fill('打ち合わせ')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveCount(0)

  await refuseWrites(page, 'events')

  // 書き換え
  await page.getByTitle('打ち合わせ', { exact: true }).first().click()
  await page.getByPlaceholder('予定のタイトル').fill('打ち合わせ（場所を変えた）')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByText(/できませんでした/)).toBeVisible()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveValue('打ち合わせ（場所を変えた）')

  // 新しく作るほうも同じ
  await page.getByRole('button', { name: 'キャンセル' }).click()
  await page.getByRole('button', { name: '予定を追加' }).click()
  await page.getByPlaceholder('予定のタイトル').fill('新しい予定')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByText(/できませんでした/)).toBeVisible()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveValue('新しい予定')
})

test('リマインドの保存に失敗したら、画面を閉じずに入力を残す', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await page.getByRole('button', { name: 'リマインド' }).click()

  const add = page.getByPlaceholder('やること・忘れたくないことを入力')
  await add.fill('資料をまとめる')
  await add.press('Enter')
  await expect(page.getByText('資料をまとめる')).toBeVisible()

  await refuseWrites(page, 'todos')

  await page.getByText('資料をまとめる').click()
  await expect(page.getByRole('heading', { name: 'リマインドを編集' })).toBeVisible()
  const title = page.getByRole('dialog').getByRole('textbox').first()
  await title.fill('資料をまとめて送る')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await expect(page.getByText(/できませんでした/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'リマインドを編集' })).toBeVisible()
  await expect(title).toHaveValue('資料をまとめて送る')
})

/*
 * 時刻や日付の欄を空にしたまま保存すると、読めずに例外になり、「保存中」のまま
 * 画面が固まっていた（閉じるしかなく、書いた中身が消える）。空いている欄を言い、
 * 埋めるまで保存させない。
 */
test('予定の時刻を空にしたら、固まらずに理由を出し、埋めれば保存できる', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await page.getByRole('button', { name: 'カレンダー' }).click()
  await expect(page.getByRole('button', { name: '今日' })).toBeVisible()

  await page.getByRole('button', { name: '予定を追加' }).click()
  await page.getByPlaceholder('予定のタイトル').fill('打ち合わせ')
  // 新しい予定は終日で始まる。時刻の欄は、終日を外すと出る
  await page.getByRole('checkbox', { name: '終日' }).uncheck()
  const startTime = page.getByRole('dialog').locator('input[type="time"]').first()
  await startTime.fill('')

  await expect(page.getByText('開始の日付と時刻を入れてください')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()

  await startTime.fill('10:00')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveCount(0)
  await expect(page.getByTitle('打ち合わせ', { exact: true }).first()).toBeVisible()
})
