import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  addFirstNote,
  boardToolbar,
  createBoard,
  openAsGuest,
  signIn,
  waitForSaved,
  writeInNote,
} from './helpers'

/*
 * オフラインのあいだに書いたものを、つながってから送る。
 *
 * ここでしか確かめられないのは「リロードを跨いで残るか」。
 * useRealtimeTable の保留（hold）はメモリ上にあり、購読しなおすたびに
 * 作り直される。送信箱から保留を張り直す仕組みが抜けていると、
 * リロードした瞬間に「サーバーが知らない行」として消える——
 * 画面上は何ごともなく消えるので、目で見ても気づけない。
 */

test.skip(
  !process.env.E2E_BACKEND_READY,
  'ローカルの Supabase につながらないので飛ばします（supabase start）',
)

const stamp = () => `E2E オフライン ${Date.now().toString(36)}`

/**
 * 2 枚目以降の付箋を置く。
 * 何も無いボードの案内（付箋を貼る）は 1 枚目にしか出ないので、道具から置く。
 */
async function placeNote(page: Page, x: number, y: number) {
  const before = await page.locator('[data-ctx-kind="note"]').count()
  await page.getByRole('button', { name: '付箋（N）' }).click()
  await page.locator('[data-place-surface]').click({ position: { x, y } })
  await expect(page.locator('[data-ctx-kind="note"]')).toHaveCount(before + 1)
  // 置いたあとも道具は「付箋」のまま。次の操作のために選択へ戻す
  await page.getByRole('button', { name: '選択（V）' }).click()
}

/*
 * 書き込みだけを落として「オフラインのように」する。
 *
 * context.setOffline だと画面そのものを読み直せない。開発サーバーは
 * Service Worker を登録しない（usePwa が dev では入れない）ので、
 * オフラインのままのリロードが試せない——ここでいちばん確かめたいのが
 * まさにそれなので、読み取りは通し、書き込みだけを落とす。
 */
async function blockWrites(context: BrowserContext) {
  await context.route('**/rest/v1/**', (route) => {
    const request = route.request()
    const method = request.method()
    // RPC は読み取りでも POST で来る（get_room_preview など）。落とすと
    // ボードそのものが開けなくなるので、表への書き込みだけを落とす
    if (method === 'GET' || method === 'HEAD' || request.url().includes('/rest/v1/rpc/')) {
      return route.continue()
    }
    return route.abort('internetdisconnected')
  })
}

async function allowWrites(context: BrowserContext) {
  await context.unroute('**/rest/v1/**')
}

/** いま置いた（いちばん新しい）付箋に文字を入れる */
async function writeInLastNote(page: Page, text: string) {
  await page.locator('[data-ctx-kind="note"]').last().dblclick()
  const editor = page.getByLabel('付箋の本文')
  await expect(editor).toBeFocused()
  await editor.fill(text)
  await editor.press('Escape')
  await expect(editor).toHaveCount(0)
}

test('オフラインで書いたものが、リロードを跨いで残り、つながると送られる', async ({
  page,
  context,
}) => {
  await signIn(page, 'ひとり目')
  const url = await createBoard(page, stamp())

  await addFirstNote(page)
  await writeInNote(page, 'つながっているうちに書いた')
  await waitForSaved(page)

  // ---- 書き込みが届かない状態にして書く
  await blockWrites(context)

  await placeNote(page, 500, 200)
  await writeInLastNote(page, 'オフラインで書いた')

  const pill = page.getByRole('button', { name: /件未送信/ })
  await expect(pill).toBeVisible({ timeout: 20_000 })

  // ---- オフラインのままリロードしても残っている（ここが山場）
  await page.reload()
  await expect(page.getByText('オフラインで書いた', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('button', { name: /件未送信/ })).toBeVisible()

  // ---- つながると送られる
  await allowWrites(context)
  await expect(page.getByRole('button', { name: /件未送信/ })).toHaveCount(0, { timeout: 30_000 })

  // ---- 本当にサーバーへ届いている（別のブラウザから見える）
  const { context: guestContext, page: guest } = await openAsGuest(
    page.context().browser()!,
    url,
    'ふたり目',
  )
  try {
    await expect(guest.getByText('オフラインで書いた', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
  } finally {
    await guestContext.close()
  }
})

test('つながっていないあいだに作って取り消したものは、1 件も送らない', async ({
  page,
  context,
}) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await waitForSaved(page)

  await blockWrites(context)

  await addFirstNote(page)
  await writeInNote(page, 'すぐ取り消す')
  await expect(page.getByRole('button', { name: /件未送信/ })).toBeVisible({ timeout: 20_000 })

  /*
   * 付箋が消えるまで取り消す。
   * 文字を入れる操作は 1 回とは限らない（編集の開始と確定で積まれる）ので、
   * 押す回数を決め打ちにしない。
   */
  const note = page.locator('[data-ctx-kind="note"]')
  for (let i = 0; i < 5 && (await note.count()) > 0; i++) {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
  }
  await expect(note).toHaveCount(0, { timeout: 20_000 })

  // つなぎ直しても、この付箋のための書き込みは 1 本も出ない
  // （作って消したので、送信箱の中で相殺されている）
  const posted: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/rest/v1/notes')) posted.push(request.postData() ?? '')
  })

  await allowWrites(context)
  await page.waitForTimeout(4_000)
  expect(posted.filter((body) => body.includes('すぐ取り消す'))).toHaveLength(0)
})

test('オフラインのあいだは、画像やファイルを置けないとはっきり言う', async ({ page, context }) => {
  await signIn(page, 'ひとり目')
  await createBoard(page, stamp())
  await expect(boardToolbar(page)).toBeVisible()

  await context.setOffline(true)

  // ファイル選択の入口から、画像を 1 枚選ぶ
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'a.png',
    mimeType: 'image/png',
    // 1x1 の PNG
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  })

  await expect(page.getByText('オフラインのあいだは画像を貼れません', { exact: false })).toBeVisible(
    { timeout: 20_000 },
  )
})
