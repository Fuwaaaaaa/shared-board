import { expect, test } from '@playwright/test'
import {
  addFirstNote,
  createBoard,
  dragAndWaitForSave,
  positionOf,
  recordSyncStates,
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

/*
 * 貼った付箋の保存（INSERT）が返る前に文字を書くと、文字の UPDATE が先に届いて
 * 0 行で終わり、「すでに消されています」として捨てられていた。そのあと INSERT が
 * 通るので、リロードすると文字の無い付箋だけが残る。
 *
 * 上の @smoke が CI でときどき落ちていたのはこれ。手元の DB は速くてまず当たらないので、
 * INSERT の返事を遅らせて毎回この順番にする。
 */
test('付箋を貼る保存が遅くても、すぐ書いた文字はリロードしても残る', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())

  await page.route('**/rest/v1/notes*', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    await route.continue()
  })

  const syncStates = await recordSyncStates(page)
  await addFirstNote(page)
  await writeInNote(page, '合宿の持ち物')
  await waitForSaved(page)
  await expect(page.getByText(/できませんでした/)).toHaveCount(0)

  // 作成が返ってから文字の保存が出るまでのあいだに、一瞬でも「保存済み」を挟まない。
  // 挟むと、そこで閉じたり読み込み直したりした人の文字が消える
  const states = await syncStates()
  expect(states.slice(states.indexOf('同期中'))).toEqual(['同期中', '保存済み'])

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

/*
 * 取り消した付箋は保存を待たずに戻るので、見てすぐやり直しを押せる。
 * そのとき取り消しの保存がまだ返っていなくても、やり直しは捨てない。
 *
 * 手元の DB は速く、上のテストではこの隙間にまず当たらない（CI ではときどき当たって
 * 落ちていた）。書き込みの返事を遅らせて、隙間を毎回つくる。
 */
test('保存が遅くても、取り消した直後のやり直しが効く', async ({ page }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await addFirstNote(page)
  await waitForSaved(page)

  const before = await positionOf(page, '[data-ctx-kind="note"]')
  await dragAndWaitForSave(page, '[data-ctx-kind="note"]', 'notes', 120, 80)
  // 待った PATCH がドラッグ前の書き込みの返事のこともあるので、動くまで待つ
  await expect
    .poll(async () => (await positionOf(page, '[data-ctx-kind="note"]')).left)
    .not.toBe(before.left)
  // 遅らせたいのは取り消しの保存だけ。ドラッグの保存は先に終わらせておく。
  // 「保存済み」は patch が返り終えるまで出ないので（holdSaving）、ドラッグの取り消しは
  // もう積まれている。ここで Ctrl+Z を押しても、1 つ前の「付箋の追加」を取り消さない
  await waitForSaved(page)
  const moved = await positionOf(page, '[data-ctx-kind="note"]')

  await page.route('**/rest/v1/notes*', async (route) => {
    if (route.request().method() === 'PATCH') {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    await route.continue()
  })

  await page.keyboard.press('Control+z')
  await expect.poll(async () => positionOf(page, '[data-ctx-kind="note"]')).toEqual(before)

  // 取り消しの保存はまだ返っていない
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(async () => positionOf(page, '[data-ctx-kind="note"]')).toEqual(moved)

  // 戻ってきた返事で、画面が取り消しの位置へ引き戻されない
  await waitForSaved(page)
  expect(await positionOf(page, '[data-ctx-kind="note"]')).toEqual(moved)
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
