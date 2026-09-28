import { expect, test, type Page } from '@playwright/test'
import { createBoard, signIn } from './helpers'

/*
 * 繰り返し予定の「この回だけ」。
 *
 * README が「間違えやすい」と断っている場所で、しかもカレンダーのタブは
 * これまでブラウザから一度も触っていなかった。純粋関数（recurrence.ts）の
 * テストは厚いが、そこと画面のつなぎ目——どの回を開いているか、
 * 変更がその回だけに効くか——はここでしか確かめられない。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E ${Date.now().toString(36)}`

async function openCalendar(page: Page) {
  await page.getByRole('button', { name: 'カレンダー' }).click()
  await expect(page.getByRole('button', { name: '今日' })).toBeVisible()
}

/** 予定を 1 件足す。recurrence を渡すと繰り返しにする */
async function addEvent(page: Page, title: string, recurrence?: string) {
  await page.getByRole('button', { name: '予定を追加' }).click()
  await page.getByPlaceholder('予定のタイトル').fill(title)
  if (recurrence) {
    await page.getByRole('combobox').first().selectOption({ label: recurrence })
  }
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveCount(0)
}

/**
 * 翌月を表示する。予定は今日から始まるので、今月の表示で数えると月末の週には
 * 1〜2 回しか並ばない（9/28 に走らせると、毎週は 9/28 の 1 回だけ）。
 * 翌月なら、今日がいつでも 4 週ぶん以上並ぶ。
 */
async function showNextMonth(page: Page) {
  await page.getByRole('button', { name: '›', exact: true }).click()
}

test('繰り返し予定を「この回だけ」変えると、その回にだけ効く', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await openCalendar(page)

  await addEvent(page, '定例会', '毎週')
  await showNextMonth(page)

  // 翌月には、少なくとも数回は並ぶ
  const all = page.getByTitle('定例会', { exact: true })
  await expect
    .poll(async () => await all.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2)
  const before = await all.count()

  // 2 回目を開くと、既定で「この回だけ変更」が選ばれている
  await all.nth(1).click()
  await expect(page.getByText('の回を開いています')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'この回だけ変更' })).toBeChecked()

  await page.getByPlaceholder('予定のタイトル').fill('定例会（午後）')
  await page.getByRole('button', { name: '保存', exact: true }).click()

  // 変えた回だけが新しい名前になり、残りはそのまま
  await expect(page.getByTitle('定例会（午後）', { exact: true })).toHaveCount(1)
  await expect(all).toHaveCount(before - 1)

  // 変えた回には ✏️ が付く
  await expect(page.getByTitle('この回だけ変更しています')).toHaveCount(1)
})

test('繰り返し予定を「この回だけ」削除しても、ほかの回は残る', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept())

  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await openCalendar(page)

  await addEvent(page, '朝の会', '毎日')
  await showNextMonth(page)

  const all = page.getByTitle('朝の会', { exact: true })
  await expect
    .poll(async () => await all.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3)
  const before = await all.count()

  await all.nth(1).click()
  await expect(page.getByRole('radio', { name: 'この回だけ変更' })).toBeChecked()
  await page.getByRole('button', { name: '削除' }).click()

  await expect(all).toHaveCount(before - 1)
})

test('繰り返しに曜日を選ぶと、その曜日ぶんだけ並ぶ', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await openCalendar(page)

  await page.getByRole('button', { name: '予定を追加' }).click()
  await page.getByPlaceholder('予定のタイトル').fill('練習')
  await page.getByRole('combobox').first().selectOption({ label: '毎週' })
  await page.getByRole('button', { name: '火', exact: true }).click()
  await page.getByRole('button', { name: '木', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveCount(0)
  await showNextMonth(page)

  // 1 週に 2 回出るので、月表示では 4 件以上並ぶ
  const all = page.getByTitle('練習', { exact: true })
  await expect.poll(async () => await all.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(4)

  /*
   * 開き直して、選んだ曜日が保存されていることを見る。
   * 画面から DB まで新しい 2 列（recurrence_days / recurrence_week）が
   * 通っていることを、ここで一度だけ確かめる。
   */
  await all.first().click()
  await page.getByRole('radio', { name: 'すべての回を変更' }).click()
  await expect(page.getByRole('button', { name: '火', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: '木', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: '水', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
})

test('繰り返しに「n 回ごと」を選ぶと、保存されて開き直しても残る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await openCalendar(page)

  await page.getByRole('button', { name: '予定を追加' }).click()
  await page.getByPlaceholder('予定のタイトル').fill('隔週練習')
  await page.getByRole('combobox').first().selectOption({ label: '毎週' })
  await page.getByLabel('何回ごとか').selectOption('2')
  await page.getByRole('button', { name: '火', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('予定のタイトル')).toHaveCount(0)

  const all = page.getByTitle('隔週練習', { exact: true })
  await expect.poll(async () => await all.count(), { timeout: 20_000 }).toBeGreaterThan(0)

  /*
   * 開き直して、間隔が保存されていることを見る。
   * 画面から DB まで recurrence_interval が通っていることを、ここで一度だけ確かめる。
   * 件数で見ないのは、月の境目で 2 件にも 3 件にもなるため。
   */
  await all.first().click()
  await page.getByRole('radio', { name: 'すべての回を変更' }).click()
  await expect(page.getByLabel('何回ごとか')).toHaveValue('2')
  await expect(page.getByRole('button', { name: '火', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('繰り返し予定の出欠は、その回にだけ付く', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await openCalendar(page)

  await addEvent(page, '合宿の下見', '毎週')
  await showNextMonth(page)

  const all = page.getByTitle('合宿の下見', { exact: true })
  await expect.poll(async () => await all.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

  // 2 回目に ○ を付ける
  await all.nth(1).click()
  await expect(page.getByText('の回を開いています')).toBeVisible()
  // ボタンの文字は ○ なので、名前ではなく title で指す
  await page.getByTitle('行く', { exact: true }).click()
  await expect(page.getByText('○1 △0 ×0')).toBeVisible()
  await page.keyboard.press('Escape')

  // その回のチップにだけ ○1 が付く
  await expect(page.getByTitle('1 人が行くと答えています')).toHaveCount(1)

  // ほかの回は空のまま
  await all.nth(0).click()
  await expect(page.getByText('○0 △0 ×0')).toBeVisible()
})
