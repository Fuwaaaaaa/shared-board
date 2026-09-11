import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { signIn, createBoard } from './helpers'

const stamp = () => `book-${Date.now().toString(36)}`

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

/**
 * ボードを PNG で保存して、中身のバイト列を返す。
 *
 * Canvas は jsdom で測れないので、書き出しの中身を見られるのはここだけ。
 * 画素まで比べる代わりに「置く前と置いた後でバイト列が変わるか」を見る。
 * 描かれていなければ 1 バイトも変わらない。
 */
async function exportPng(page: Page): Promise<Buffer> {
  const wait = page.waitForEvent('download')
  await page.getByRole('button', { name: 'ボードを PNG で保存' }).click()
  const download = await wait
  const path = await download.path()
  return readFileSync(path!)
}

/*
 * フレーム・線・ファイルは、これまで PNG に写っていなかった
 * （renderPng が付箋・手描き・画像しか渡していなかった）。
 * 画面にあるのに書き出すと消えるので、「見たまま」が崩れていた。
 */
test('フレームと線が PNG に写る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  const url = await createBoard(page, stamp())
  expect(url).toContain('/r/')

  // 付箋を 2 枚。1 枚目は空のボードの案内から、2 枚目は道具から置く
  await page.getByRole('button', { name: '付箋を貼る' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '付箋（N）' }).click()
  // 2 枚目は離して置く。重なっていると線が付箋の下に隠れて、写っても見た目が変わらない
  await page.locator('[data-place-surface]').click({ position: { x: 1000, y: 200 } })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-ctx-kind="note"]')).toHaveCount(2)

  const before = await exportPng(page)

  // フレームを 1 つ置く
  await page.getByRole('button', { name: 'フレーム（F）' }).click()
  await page.locator('[data-place-surface]').click({ position: { x: 300, y: 250 } })
  await expect(page.locator('[data-ctx-kind="frame"]')).toHaveCount(1)
  await page.getByRole('button', { name: '選択（V）' }).click()

  const withFrame = await exportPng(page)
  expect(withFrame.equals(before)).toBe(false)

  // 付箋どうしを線でつなぐ
  await page.getByRole('button', { name: 'つなぐ（C）' }).click()
  const notes = page.locator('[data-ctx-kind="note"]')
  await notes.nth(0).click()
  await notes.nth(1).click()

  // 線のクリック用の当たり判定は「選択」モードでしか描かれないので、戻してから数える
  await page.getByRole('button', { name: '選択（V）' }).click()
  await expect(page.locator('[data-ctx-kind="connector"]')).toHaveCount(1)

  const withConnector = await exportPng(page)
  expect(withConnector.equals(withFrame)).toBe(false)
})
