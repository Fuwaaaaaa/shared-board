import { expect, test } from '@playwright/test'
import {
  addFirstNote,
  createBoard,
  dragAndWaitForSave,
  positionOf,
  signIn,
  waitForSaved,
  writeInNote,
} from './helpers'

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

/** 走らせるたびに別のボードにする。前の回の残りを踏まない */
const stamp = () => `E2E ${Date.now().toString(36)}`

/*
 * @smoke … Firefox / WebKit でも走る。
 * ボードを作って、書いて、保存されて、開き直しても残る —— この一本が通らなければ、
 * そのブラウザではこのアプリは使えない。
 */
test('@smoke 名前を入れて、ボードを作って、付箋を置くと、リロードしても残る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  await addFirstNote(page)
  await writeInNote(page, '合宿の持ち物')
  await waitForSaved(page)

  await page.reload()
  await expect(page.locator('[data-ctx-kind="note"]')).toHaveCount(1)
  await expect(page.getByText('合宿の持ち物')).toBeVisible()
})

test('共有リンクを開いた 2 人目にも、書いたものが届く', async ({ page, browser }) => {
  await signIn(page, 'ひとり目')
  const url = await createBoard(page, stamp())

  await addFirstNote(page)
  await writeInNote(page, '文化祭の出し物')
  await waitForSaved(page)

  // 別のブラウザとして開く。表示名も別に聞かれる（ログインが無いので）
  const second = await browser.newContext()
  const guest = await second.newPage()
  try {
    await guest.goto(url)
    const nameField = guest.getByLabel('表示名を入力してください')
    await expect(nameField).toBeVisible()
    await nameField.fill('ふたり目')
    await guest.getByRole('button', { name: 'はじめる' }).click()

    await expect(guest.getByText('文化祭の出し物')).toBeVisible({ timeout: 20_000 })

    // 1 人目が「あとから」置いたものが、開いたままの 2 人目にも届く。
    // ここが Realtime を通っている証拠になる（開き直しでは分からない）
    await page.getByRole('button', { name: '付箋（N）' }).click()
    await page.mouse.click(600, 450)
    await expect(page.locator('[data-ctx-kind="note"]')).toHaveCount(2)

    await expect(guest.locator('[data-ctx-kind="note"]')).toHaveCount(2, { timeout: 20_000 })
  } finally {
    await second.close()
  }
})

test('付箋を動かして Ctrl+Z を押すと、元の位置に戻る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await addFirstNote(page)
  await waitForSaved(page)

  const before = await positionOf(page, '[data-ctx-kind="note"]')

  await dragAndWaitForSave(page, '[data-ctx-kind="note"]', 'notes', 120, 80)
  await expect
    .poll(async () => (await positionOf(page, '[data-ctx-kind="note"]')).left)
    .not.toBe(before.left)

  await page.keyboard.press('Control+z')
  await expect.poll(async () => positionOf(page, '[data-ctx-kind="note"]')).toEqual(before)

  // やり直しも効く
  await page.keyboard.press('Control+Shift+z')
  await expect
    .poll(async () => (await positionOf(page, '[data-ctx-kind="note"]')).left)
    .not.toBe(before.left)
})

test('ファイルを置いて動かして Ctrl+Z を押すと、元の位置に戻る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  // 隠してあるファイル選択にそのまま渡す（📎 ボタンが開くもの）
  await page.locator('input[type=file]').nth(1).setInputFiles({
    name: '合宿のしおり.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% みんなのボードのテスト\n'),
  })

  const card = '[data-ctx-kind="attachment"]'
  await expect(page.locator(card)).toHaveCount(1, { timeout: 20_000 })
  await waitForSaved(page)

  const before = await positionOf(page, card)

  await dragAndWaitForSave(page, card, 'attachments', 100, 60)
  await expect.poll(async () => (await positionOf(page, card)).left).not.toBe(before.left)

  // ここが長らく積まれていなかった。押しても何も起きない状態が正しく見えてしまう
  await page.keyboard.press('Control+z')
  await expect.poll(async () => positionOf(page, card)).toEqual(before)
})

test('付箋を「やること」にすると、リマインドに出る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await addFirstNote(page)
  await writeInNote(page, '部費を集める')
  await waitForSaved(page)

  await page.locator('[data-ctx-kind="note"]').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /やることにする/ }).click()

  await expect(page.getByRole('heading', { name: '付箋から作る' })).toBeVisible()
  await page.getByRole('button', { name: '作る', exact: true }).click()
  await expect(page.getByRole('heading', { name: '付箋から作る' })).toHaveCount(0)

  await page.getByRole('button', { name: /リマインド/ }).click()
  await expect(page.getByText('部費を集める')).toBeVisible()
})
