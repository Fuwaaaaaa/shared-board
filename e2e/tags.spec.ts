import { expect, test } from '@playwright/test'
import { addFirstNote, createBoard, openAsGuest, signIn, waitForSaved, writeInNote } from './helpers'

/*
 * 付箋のタグは、コメント欄（右クリック →「コメント・タグ」）で付け外しする。
 *
 * 以前はコメント欄が開いたときの付箋の控えを持ち続けていた。開いているあいだに
 * 他の人が付けたタグは見えず、そこから組み立てたタグで保存するので、他の人のタグを
 * 黙って消していた。ロックも保存の瞬間の行で取っていたので、競合としても止まらなかった。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E タグ ${Date.now().toString(36)}`
const TAG_INPUT = 'タグを追加して Enter'

test('コメント欄を開いているあいだに他の人が付けたタグを、消さずに足す', async ({ page, browser }) => {
  await signIn(page, 'ひとり目')
  const url = await createBoard(page, stamp())
  await addFirstNote(page)
  await writeInNote(page, '合宿の持ち物')
  await waitForSaved(page)

  // ひとり目はコメント欄を開いたままにしておく
  await page.locator('[data-ctx-kind="note"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /コメント・タグ/ }).click()
  await expect(page.getByRole('heading', { name: '付箋' })).toBeVisible()

  const { context, page: guest } = await openAsGuest(browser, url, 'ふたり目')
  try {
    await expect(guest.getByText('合宿の持ち物')).toBeVisible({ timeout: 20_000 })
    await guest.locator('[data-ctx-kind="note"]').click({ button: 'right' })
    await guest.getByRole('menuitem', { name: /コメント・タグ/ }).click()
    await guest.getByPlaceholder(TAG_INPUT).fill('買い出し')
    await guest.getByPlaceholder(TAG_INPUT).press('Enter')
    await waitForSaved(guest)

    // 開き直さなくても、ひとり目の欄に出る
    await expect(page.getByRole('button', { name: '買い出し を外す' })).toBeVisible({
      timeout: 20_000,
    })

    await page.getByPlaceholder(TAG_INPUT).fill('当日')
    await page.getByPlaceholder(TAG_INPUT).press('Enter')
    await waitForSaved(page)

    // どちらのタグも残る
    await expect(guest.getByRole('button', { name: '当日 を外す' })).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByRole('button', { name: '買い出し を外す' })).toBeVisible()
    await expect(page.getByRole('button', { name: '買い出し を外す' })).toBeVisible()
  } finally {
    await context.close()
  }
})
