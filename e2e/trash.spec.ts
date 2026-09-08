import { expect, test } from '@playwright/test'
import { addFirstNote, createBoard, signIn, waitForSaved, writeInNote } from './helpers'

/*
 * ゴミ箱。
 *
 * 「消した付箋・予定・やること・画像は 30 日戻せます（他の人が消したものも）」は
 * README で約束していることのひとつ。Ctrl+Z は自分がこのタブで行った操作にしか
 * 効かないので、ここが最後の受け皿になる。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E ${Date.now().toString(36)}`

test('消した付箋を、ゴミ箱から戻せる', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept())

  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  await addFirstNote(page)
  await writeInNote(page, '会場を押さえる')
  await waitForSaved(page)

  const note = page.locator('[data-ctx-kind="note"]')
  await expect(note).toHaveCount(1)

  // 選んで Delete で消す
  await note.click()
  await page.keyboard.press('Delete')
  await expect(note).toHaveCount(0)

  // 更新タブのゴミ箱から戻す
  await page.getByRole('button', { name: '更新' }).click()
  await page.getByRole('button', { name: 'ゴミ箱' }).click()
  await expect(page.getByRole('heading', { name: 'ゴミ箱' })).toBeVisible()
  await expect(page.getByText('会場を押さえる', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '戻す' }).first().click()
  await expect(page.getByText('ゴミ箱は空です。')).toBeVisible()

  // ホワイトボードに戻っている
  await page.getByRole('button', { name: '閉じる' }).click()
  await page.getByRole('button', { name: 'ホワイトボード' }).click()
  await expect(page.locator('[data-ctx-kind="note"]')).toHaveCount(1)
  await expect(page.getByText('会場を押さえる', { exact: true })).toBeVisible()
})


test('消したフレームも、ゴミ箱から戻せる', async ({ page }) => {
  /*
   * フレーム・線・ファイルは、これまでハード削除だった。
   * Ctrl+Z が自分の操作にしか効かない以上、他の人が消したものを
   * 取り返す道が無かったところ。
   */
  page.on('dialog', (dialog) => void dialog.accept())

  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  // フレームを 1 つ置く
  await page.getByRole('button', { name: 'フレーム（F）' }).click()
  await page.locator('[data-place-surface]').click({ position: { x: 400, y: 300 } })
  const frame = page.locator('[data-ctx-kind="frame"]')
  await expect(frame).toHaveCount(1)
  await waitForSaved(page)

  // 置いたあとも道具は「フレーム」のままで、置くための透明な層が全面を覆っている。
  // 選択に戻さないと掴めない
  await page.getByRole('button', { name: '選択（V）' }).click()

  // 選ぶと名前バーに 🗑 が出る。フレームはそこから消す
  await frame.click()
  await page.getByTitle('削除', { exact: true }).click()
  await expect(frame).toHaveCount(0)

  // ゴミ箱から戻す
  await page.getByRole('button', { name: '更新' }).click()
  await page.getByRole('button', { name: 'ゴミ箱' }).click()
  await expect(page.getByRole('heading', { name: 'ゴミ箱' })).toBeVisible()
  await expect(page.getByText('（名前なしのフレーム）')).toBeVisible()

  await page.getByRole('button', { name: '戻す' }).first().click()
  await expect(page.getByText('ゴミ箱は空です。')).toBeVisible()

  await page.getByRole('button', { name: '閉じる' }).click()
  await page.getByRole('button', { name: 'ホワイトボード' }).click()
  await expect(page.locator('[data-ctx-kind="frame"]')).toHaveCount(1)
})
