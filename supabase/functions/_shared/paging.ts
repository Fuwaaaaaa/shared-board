/*
 * PostgREST から、上限で切られずに全部読む。
 *
 * Supabase の PostgREST は、1 回に返す行数に上限がある（既定の max_rows は 1000）。
 * 超えた分はエラーにならず黙って切られるので、ページに分けて読み切る。
 *
 * 上限の値には頼らず、空のページが返るまで読む。上限が 1000 より小さく設定されて
 * いても取りこぼさない（その代わり、最後に 1 回だけ空の問い合わせが増える）。
 * 並びが決まっていないとページの境目で行が重なったり抜けたりするので、呼ぶ側は
 * 必ず order を付けること。
 */

/** 1 ページに頼む行数 */
export const PAGE_SIZE = 1000

export interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

/**
 * page(from, to) で 1 ページずつ読み、全部つなげて返す。max を渡すとそこで止める。
 * 途中で失敗したら、そこまでに読めた行と error を返す。
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  max = Number.POSITIVE_INFINITY,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = []
  while (rows.length < max) {
    const from = rows.length
    const to = Math.min(from + PAGE_SIZE, max) - 1
    const { data, error } = await page(from, to)
    if (error) return { data: rows, error }
    if (!data || data.length === 0) break
    rows.push(...data)
  }
  return { data: rows, error: null }
}
