/**
 * ボードに置いたファイルのカードの中身。
 *
 * 画面（AttachmentsLayer）と PNG の書き出し（boardExport）の両方が使うので、
 * DOM に触らない判断だけをここへ出してある。noteFont.ts と同じ立て付け。
 */

/** 種類に合わせた絵文字。分からないものは 📎 */
export function attachmentIcon(mime: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (mime.includes('pdf') || ext === 'pdf') return '📕'
  if (['doc', 'docx'].includes(ext)) return '📘'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗'
  if (['ppt', 'pptx'].includes(ext)) return '📙'
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime.startsWith('video/')) return '🎬'
  if (mime.startsWith('text/')) return '📄'
  return '📎'
}

/** 大きさの言い方。1 KB 未満はバイト、1 MB 未満は KB */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
