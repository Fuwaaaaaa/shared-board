import { expect, test } from '@playwright/test'
import { createBoard, signIn, waitForSaved } from './helpers'

/*
 * コメントは付箋・予定・やることに加えて、画像・ファイル・フレームにも付く。
 *
 * ここで見るのはつなぎ目——右クリックから開けるか、DB に入るか、
 * 検索に「フレームへのコメント」として出るか。付けられる先の顔ぶれそのものは
 * pgTAP（comments_target_type_check）が見ている。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E ${Date.now().toString(36)}`

test('フレームにコメントを付けると、検索に出る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  // フレームを 1 つ置いて、選択モードに戻す
  await page.getByRole('button', { name: 'フレーム（F）' }).click()
  await page.locator('[data-place-surface]').click({ position: { x: 400, y: 300 } })
  await expect(page.locator('[data-ctx-kind="frame"]')).toHaveCount(1)
  await page.getByRole('button', { name: '選択（V）' }).click()
  await waitForSaved(page)

  await page.locator('[data-ctx-kind="frame"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /コメント/ }).click()

  await expect(page.getByRole('heading', { name: 'フレーム' })).toBeVisible()
  await page.getByPlaceholder('メッセージを入力').fill('ここは来週やる')
  await page.getByRole('button', { name: '送信' }).click()
  await expect(page.getByText('ここは来週やる')).toBeVisible()

  await page.getByRole('button', { name: '閉じる' }).click()
  await waitForSaved(page)

  // 検索に「フレームへのコメント」として出る。
  // 生きているかを見る一覧にフレームを足し忘れていると、ここで 0 件になる
  await page.keyboard.press('Control+f')
  await page.getByPlaceholder('キーワードを入力（付箋・予定・リマインド・コメント）').fill('来週')
  await expect(page.getByText('フレームへのコメント')).toBeVisible()
})
