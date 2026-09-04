import { expect, type Browser, type Page } from '@playwright/test'

/** 表示名を入れる。これが唯一の「ログイン」 */
export async function enterName(page: Page, displayName: string) {
  const nameField = page.getByLabel('表示名を入力してください')
  await expect(nameField).toBeVisible()
  await nameField.fill(displayName)
  await page.getByRole('button', { name: 'はじめる' }).click()
}

/** 表示名を入れて、ボードを作る画面まで進む */
export async function signIn(page: Page, displayName: string) {
  await page.goto('/')
  await enterName(page, displayName)
  await expect(page.getByRole('heading', { name: '新しいボードを作る' })).toBeVisible()
}

/**
 * 別のブラウザとして共有 URL を開く。
 *
 * ログインが無いので、同じ URL でも表示名から聞かれる。
 * 呼んだ側が context を閉じること。
 */
export async function openAsGuest(browser: Browser, url: string, displayName: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(url)
  await enterName(page, displayName)
  return { context, page }
}

/** ボードを作って、その共有 URL を返す */
export async function createBoard(
  page: Page,
  title: string,
  access: { mode?: 'link' | 'pin' | 'approval'; pin?: string } = {},
): Promise<string> {
  await page.getByPlaceholder('ボード名').fill(title)

  if (access.mode === 'pin') {
    await page.getByRole('button', { name: /合言葉つき/ }).click()
    await page.getByPlaceholder('合言葉').fill(access.pin ?? '')
  } else if (access.mode === 'approval') {
    await page.getByRole('button', { name: /承認制/ }).click()
  }

  await page.getByRole('button', { name: 'ボードを作成' }).click()
  await page.waitForURL(/\/r\/[^/?]+/)

  // 作成直後は共有モーダルが自動で開く。閉じないと後の操作を全部さえぎる
  const close = page.getByRole('button', { name: '閉じる' })
  await close.click()
  await expect(close).toHaveCount(0)

  return page.url().replace(/\?.*$/, '')
}

/** 最初の 1 枚を置く（何も無いボードの案内から） */
export async function addFirstNote(page: Page) {
  await page.getByRole('button', { name: '付箋を貼る' }).click()
  await expect(page.locator('[data-ctx-kind="note"]')).toHaveCount(1)
}

/** 付箋に文字を入れて確定する */
export async function writeInNote(page: Page, text: string) {
  const note = page.locator('[data-ctx-kind="note"]').first()
  await note.dblclick()
  const editor = page.getByLabel('付箋の本文')
  await expect(editor).toBeFocused()
  await editor.fill(text)
  await editor.press('Escape')
  await expect(editor).toHaveCount(0)
}

/** 要素を掴んで、画面上の距離だけ動かす */
export async function dragBy(page: Page, selector: string, dx: number, dy: number) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`掴めない: ${selector}`)

  const fromX = box.x + box.width / 2
  const fromY = box.y + box.height / 2
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  // 1 度に飛ばすと pointermove が 1 回しか出ず、掴んだ扱いにならないことがある
  await page.mouse.move(fromX + dx / 2, fromY + dy / 2)
  await page.mouse.move(fromX + dx, fromY + dy)
  await page.mouse.up()
}

/** 左上からの位置（ボードの座標ではなく、style の left / top） */
export async function positionOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }))
}

/** 「保存済み」が出るまで待つ。押した直後に読み直すと取りこぼす */
export async function waitForSaved(page: Page) {
  await expect(page.getByText('保存済み')).toBeVisible({ timeout: 20_000 })
}

/** ボードの中に入れているか（ツールバーが出ているか） */
export function boardToolbar(page: Page) {
  return page.getByRole('button', { name: '付箋（N）' })
}

/** 参加者パネルを開く */
export async function openMembers(page: Page) {
  await page.getByRole('button', { name: /^👥/ }).click()
  await expect(page.getByRole('heading', { name: '参加者' })).toBeVisible()
}

/** ボードの設定を開く（ヘッダーのボード名） */
export async function openBoardSettings(page: Page, title: string) {
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await expect(page.getByRole('heading', { name: 'ボードの設定' })).toBeVisible()
}
