import { expect, test } from '@playwright/test'
import { addFirstNote, boardToolbar, createBoard, signIn, waitForSaved, writeInNote } from './helpers'

/*
 * 横断検索と、そこからのジャンプ。
 *
 * 並べ替えや打ち切りの判断は search.ts のテストが厚く見ている。ここで見るのは
 * そのつなぎ目——Ctrl+F で開くか、選んだものがあるタブへ実際に飛ぶか——だけ。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E ${Date.now().toString(36)}`

test('Ctrl+F で検索して、選ぶとその付箋まで飛ぶ', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  await addFirstNote(page)
  await writeInNote(page, '体育館の鍵をもらう')
  await waitForSaved(page)

  // 別のタブに移ってから検索する（飛べたことが分かるように）
  await page.getByRole('button', { name: 'リマインド' }).click()
  await expect(page.getByPlaceholder('やること・忘れたくないことを入力')).toBeVisible()

  await page.keyboard.press('Control+f')
  await expect(page.getByRole('heading', { name: 'ボード内を検索' })).toBeVisible()

  await page.getByPlaceholder('キーワードを入力（付箋・予定・リマインド・コメント）').fill('体育館')
  await page.getByText('体育館の鍵をもらう').first().click()

  // ホワイトボードに戻り、その付箋が出ている
  await expect(boardToolbar(page)).toBeVisible()
  await expect(page.locator('[data-ctx-kind="note"]')).toContainText('体育館の鍵をもらう')
})

test('見つからないときは、そう言う', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  await page.keyboard.press('Control+f')
  await page
    .getByPlaceholder('キーワードを入力（付箋・予定・リマインド・コメント）')
    .fill('ぜったいにない言葉')

  await expect(page.getByText('見つかりませんでした。')).toBeVisible()
})
