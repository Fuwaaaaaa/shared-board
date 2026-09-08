/*
 * .ics の書き出し。本体は Edge Function（board-ics）と共有している。
 * ここには「ブラウザに保存させる」部分だけを足す。
 */

export * from '../../supabase/functions/_shared/ics.ts'

/** テキストをファイルとしてダウンロードさせる */
export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  downloadBlob(filename, blob)
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 少し待ってから開放しないと、ブラウザによってはダウンロードが中断される
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
