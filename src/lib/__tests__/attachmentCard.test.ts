import { describe, expect, it } from 'vitest'
import { attachmentIcon, formatFileSize } from '../attachmentCard'

describe('attachmentIcon', () => {
  it('mime でも拡張子でも PDF を見分ける', () => {
    expect(attachmentIcon('application/pdf', 'a.bin')).toBe('📕')
    expect(attachmentIcon('application/octet-stream', 'a.pdf')).toBe('📕')
    expect(attachmentIcon('application/octet-stream', 'A.PDF')).toBe('📕')
  })

  it('Office 系は拡張子で見分ける', () => {
    expect(attachmentIcon('', 'a.docx')).toBe('📘')
    expect(attachmentIcon('', 'a.xlsx')).toBe('📗')
    expect(attachmentIcon('', 'a.pptx')).toBe('📙')
  })

  it('音・動画・文字は mime で見分ける', () => {
    expect(attachmentIcon('audio/mpeg', 'a.mp3')).toBe('🎵')
    expect(attachmentIcon('video/mp4', 'a.mp4')).toBe('🎬')
    expect(attachmentIcon('text/plain', 'a.txt')).toBe('📄')
  })

  it('分からないものと拡張子なしは 📎', () => {
    expect(attachmentIcon('application/octet-stream', 'a.bin')).toBe('📎')
    expect(attachmentIcon('', '拡張子なし')).toBe('📎')
  })
})

describe('formatFileSize', () => {
  it('境目で単位が変わる', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1024 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10.0 MB')
  })
})
