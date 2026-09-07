import { expect, test, type Page } from '@playwright/test'
import {
  addFirstNote,
  boardToolbar,
  createBoard,
  openAsGuest,
  openBoardSettings,
  openMembers,
  signIn,
  waitForSaved,
  writeInNote,
} from './helpers'

/*
 * 入り方と権限。
 *
 * ここを画面から確かめる意味は、pgTAP の RLS テストと役割が違うところにある。
 * RLS は「サーバーが正しく拒む」ことを見る。こちらは「画面側の判定が
 * サーバーとずれていない」ことを見る。
 *
 * 実際、リンク公開のボードでその 2 つがずれていて、初めて URL を開いた人には
 * 中身のあるボードが「まだ何もありません」に見えていた（board.spec.ts）。
 * 同じ形のずれが、合言葉・承認制・閲覧のみ・終了・取り消しにも起こりうる。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E 入り方 ${Date.now().toString(36)}`

/** 中身が入ったボードを 1 つ用意する */
async function boardWithNote(
  page: Page,
  text: string,
  access: { mode?: 'link' | 'pin' | 'approval'; pin?: string } = {},
) {
  const title = stamp()
  const url = await createBoard(page, title, access)
  await addFirstNote(page)
  await writeInNote(page, text)
  await waitForSaved(page)
  return { title, url }
}

test('短すぎる合言葉は、理由を添えて断る', async ({ page }) => {
  await signIn(page, 'ひとり目')

  await page.getByPlaceholder('ボード名').fill(stamp())
  await page.getByRole('button', { name: /合言葉つき/ }).click()
  await page.getByPlaceholder('合言葉').fill('あいことば') // 5 文字
  await page.getByRole('button', { name: 'ボードを作成' }).click()

  /*
   * サーバーは 6 文字以上を求めている（schema.sql の set_join_pin）。
   * 画面がそれを知らなかったころは、ここで作成に失敗したうえ、
   * Supabase のエラーが Error のインスタンスではないために
   * 画面には "[object Object]" とだけ出ていた。
   */
  await expect(page.getByText('6 文字以上', { exact: false })).toBeVisible()
  await expect(page.getByText('[object Object]')).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
})

test('合言葉つきのボードは、合言葉を入れれば承認を待たずに入れる', async ({ page, browser }) => {
  await signIn(page, 'ひとり目')
  const { url } = await boardWithNote(page, '合宿の持ち物', {
    mode: 'pin',
    pin: 'あきまつり2026',
  })

  const { context, page: guest } = await openAsGuest(browser, url, 'ふたり目')
  try {
    // 合言葉を入れるまでは中身が見えない
    await expect(guest.getByRole('button', { name: '参加する' })).toBeVisible()
    await expect(guest.getByText('合宿の持ち物')).toHaveCount(0)

    await guest.getByLabel('合言葉').fill('ちがうあいことば')
    await guest.getByRole('button', { name: '参加する' }).click()
    await expect(guest.getByText('合言葉が違います')).toBeVisible()
    await expect(boardToolbar(guest)).toHaveCount(0)

    await guest.getByLabel('合言葉').fill('あきまつり2026')
    await guest.getByRole('button', { name: '参加する' }).click()

    // 承認を待たずにボードへ。中身も最初から見えている
    await expect(boardToolbar(guest)).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByText('合宿の持ち物')).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
})

test('承認制のボードは、承認された瞬間にリロードなしで中身に変わる', async ({ page, browser }) => {
  await signIn(page, 'ひとり目')
  const { url } = await boardWithNote(page, '文化祭の出し物', { mode: 'approval' })

  const { context, page: guest } = await openAsGuest(browser, url, 'ふたり目')
  try {
    await guest.getByRole('button', { name: '参加をリクエスト' }).click()
    await expect(guest.getByText('承認待ちです')).toBeVisible()
    await expect(guest.getByText('文化祭の出し物')).toHaveCount(0)

    await openMembers(page)
    await page.getByRole('button', { name: '承認（編集できる）' }).click()

    // 待っている側は、何も操作していないのに画面が切り替わる
    await expect(boardToolbar(guest)).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByText('文化祭の出し物')).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
})

test('「閲覧のみ」で承認された人は、読めるが書けない', async ({ page, browser }) => {
  await signIn(page, 'ひとり目')
  const { url } = await boardWithNote(page, '部費を集める', { mode: 'approval' })

  const { context, page: guest } = await openAsGuest(browser, url, 'ふたり目')
  try {
    await guest.getByRole('button', { name: '参加をリクエスト' }).click()
    await expect(guest.getByText('承認待ちです')).toBeVisible()

    await openMembers(page)
    await page.getByRole('button', { name: '承認（閲覧のみ）' }).click()

    // 中身は読める
    await expect(guest.getByText('部費を集める')).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByText('閲覧のみ')).toBeVisible()

    // 置く道具は押せない
    await expect(boardToolbar(guest)).toBeDisabled()
    await expect(guest.getByRole('button', { name: 'ペン（P）' })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('終了したボードでは、作った人も書けなくなる', async ({ page }) => {
  await signIn(page, 'ひとり目')
  const { title } = await boardWithNote(page, '打ち上げの店')

  page.on('dialog', (dialog) => void dialog.accept())
  await openBoardSettings(page, title)
  await page.getByRole('button', { name: 'このボードを終了する' }).click()

  await expect(
    page.getByText('このボードは終了しています', { exact: false }),
  ).toBeVisible({ timeout: 20_000 })

  // 中身はそのまま読める
  await expect(page.getByText('打ち上げの店')).toBeVisible()
  // 作った人でも置けない
  await expect(boardToolbar(page)).toBeDisabled()
})

test('アクセスを取り消された人は、その場で締め出される', async ({ page, browser }) => {
  await signIn(page, 'ひとり目')
  const { url } = await boardWithNote(page, '買い出しの担当')

  const { context, page: guest } = await openAsGuest(browser, url, 'ふたり目')
  try {
    await expect(guest.getByText('買い出しの担当')).toBeVisible({ timeout: 20_000 })

    page.on('dialog', (dialog) => void dialog.accept())
    await openMembers(page)
    await page.getByRole('button', { name: 'アクセスを取り消す' }).click()

    // 開いたままの画面が、リロードを待たずに締め出しへ変わる
    await expect(guest.getByText('いまは参加できません')).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByText('買い出しの担当')).toHaveCount(0)

    // 開き直しても入れない（リンク公開でも、取り消された人は承認待ちに並ぶ）
    await guest.reload()
    await expect(guest.getByText('いまは参加できません')).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
})

test('取り消された人が申請し直すと、承認待ちに並ぶ（勝手には戻れない）', async ({
  page,
  browser,
}) => {
  await signIn(page, 'ひとり目')
  const { url } = await boardWithNote(page, '当日の集合場所')

  const { context, page: guest } = await openAsGuest(browser, url, 'ふたり目')
  try {
    await expect(guest.getByText('当日の集合場所')).toBeVisible({ timeout: 20_000 })

    page.on('dialog', (dialog) => void dialog.accept())
    await openMembers(page)
    await page.getByRole('button', { name: 'アクセスを取り消す' }).click()
    await expect(guest.getByText('いまは参加できません')).toBeVisible({ timeout: 20_000 })

    /*
     * ここがリンク公開のボードでずれていたところ。
     * 「公開かどうか」を「名簿にどう載っているか」より先に見ていたため、
     * 取り消された人がそのまま入り直せていた。
     */
    await guest.getByRole('button', { name: 'もう一度申請する' }).click()
    await expect(guest.getByText('承認待ちです')).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByText('当日の集合場所')).toHaveCount(0)

    // 作った人が戻せば入れる
    await page.getByRole('button', { name: '承認（編集できる）' }).click()
    await expect(guest.getByText('当日の集合場所')).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
})
