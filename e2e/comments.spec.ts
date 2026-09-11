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


test('消したコメントは、消した本人だけがゴミ箱から戻せる', async ({ page }) => {
  /*
   * コメントだけ、消す理由が事故ではなくモデレーションになる。だから
   * 戻せる人も「消した本人かボードを作った人だけ」に絞ってある。
   *
   * ここで見るのは、その入口と出口——消すと流れから消えること、
   * ゴミ箱に出ること、戻すと検索にも戻ること。誰が戻せるかの線引きそのものは
   * pgTAP（tg_comment_trash_guard）が両方向から見ている。
   */
  page.on('dialog', (dialog) => void dialog.accept())

  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  // ボードのチャットに 1 本書く
  await page.getByTitle('チャット').click()
  await page.getByPlaceholder('このボードのみんなに送信').fill('会場の鍵は当日うけとり')
  await page.getByRole('button', { name: '送信' }).click()
  await expect(page.getByText('会場の鍵は当日うけとり')).toBeVisible()
  await waitForSaved(page)

  // 消すとその場から消える
  await page.getByRole('button', { name: '削除' }).click()
  await expect(page.getByText('会場の鍵は当日うけとり')).toHaveCount(0)
  await page.getByRole('button', { name: '閉じる' }).click()

  // ゴミ箱に出る（消したのは自分なので見える）
  await page.getByRole('button', { name: '更新' }).click()
  await page.getByRole('button', { name: 'ゴミ箱' }).click()
  await expect(page.getByRole('heading', { name: 'ゴミ箱' })).toBeVisible()
  await expect(page.getByText('会場の鍵は当日うけとり')).toBeVisible()

  await page.getByRole('button', { name: '戻す' }).first().click()
  await expect(page.getByText('ゴミ箱は空です。')).toBeVisible()
  await page.getByRole('button', { name: '閉じる' }).click()

  // 戻ると、横断検索にもまた出る（読む側を 1 か所で塞いでいるかの確かめ）
  await page.keyboard.press('Control+f')
  await page.getByPlaceholder('キーワードを入力（付箋・予定・リマインド・コメント）').fill('鍵は当日')
  await expect(page.getByText(/ひとり目 — チャット/)).toBeVisible()
})
