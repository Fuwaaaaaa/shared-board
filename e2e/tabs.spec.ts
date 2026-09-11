import { expect, test } from '@playwright/test'
import { boardToolbar, createBoard, signIn } from './helpers'

/*
 * タブは React.lazy で分けて読み込んでいる（src/pages/RoomPage.tsx）。
 *
 * 分け方を間違えても型は通り、ビルドも通る。そのタブを実際に開いたときに
 * 初めて壊れるので、ここでは「全部のタブが本当に開くか」だけを見る。
 * 中身の細かいところは、それぞれのタブのテストの担当。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

/* @smoke … React.lazy の分割読み込みはブラウザによって転びうるので、3 つとも見る */
test('@smoke タブを切り替えると、それぞれの中身が出る', async ({ page }) => {
  // 読み込みに失敗しても画面が白くなるだけのことがあるので、エラーも拾う
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await signIn(page, 'ひとり目')
  await createBoard(page, `E2E タブ ${Date.now().toString(36)}`)

  await page.getByRole('button', { name: 'カレンダー' }).click()
  await expect(page.getByRole('button', { name: '今日' })).toBeVisible()

  await page.getByRole('button', { name: 'リマインド' }).click()
  await expect(page.getByPlaceholder('やること・忘れたくないことを入力')).toBeVisible()

  await page.getByRole('button', { name: '更新' }).click()
  await expect(page.getByRole('button', { name: 'すべて' })).toBeVisible()

  await page.getByRole('button', { name: 'ダッシュボード' }).click()
  await expect(page.getByText('担当ごとの残り')).toBeVisible()

  await page.getByRole('button', { name: 'ホワイトボード' }).click()
  await expect(boardToolbar(page)).toBeVisible()

  expect(errors, errors.join('\n')).toEqual([])
})
