import { expect, type Page } from '@playwright/test'

/** 表示名を入れて入口を抜ける。これが唯一の「ログイン」 */
export async function signIn(page: Page, displayName: string) {
  await page.goto('/')
  const nameField = page.getByLabel('表示名を入力してください')
  await expect(nameField).toBeVisible()
  await nameField.fill(displayName)
  await page.getByRole('button', { name: 'はじめる' }).click()
  await expect(page.getByRole('heading', { name: '新しいボードを作る' })).toBeVisible()
}

/** ボードを作って、その共有 URL を返す */
export async function createBoard(page: Page, title: string): Promise<string> {
  await page.getByPlaceholder('ボード名').fill(title)
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
