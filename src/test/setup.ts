/*
 * jsdom で React コンポーネントを触るための下ごしらえ。
 *
 * jsdom はレイアウトを持たず、ポインタ捕捉も実装していない。
 * ボードの操作はどちらにも寄りかかっているので、ここで最低限を足す。
 * 「本物のブラウザでしか確かめられないこと」は E2E（playwright/）の担当。
 */

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// vitest の globals を有効にしていないので、後片付けは自分で呼ぶ
afterEach(() => cleanup())

/*
 * ポインタ捕捉。付箋・画像・添付のドラッグは setPointerCapture を呼んでから
 * 動かすので、これが無いと pointerdown の時点で落ちる。
 * 捕捉の有無で分岐する処理は無いため、覚えておくだけの実装で足りる。
 */
const captured = new WeakMap<Element, Set<number>>()

Element.prototype.setPointerCapture = function (pointerId: number) {
  const ids = captured.get(this) ?? new Set<number>()
  ids.add(pointerId)
  captured.set(this, ids)
}
Element.prototype.releasePointerCapture = function (pointerId: number) {
  captured.get(this)?.delete(pointerId)
}
Element.prototype.hasPointerCapture = function (pointerId: number) {
  return captured.get(this)?.has(pointerId) ?? false
}

/*
 * PointerEvent。jsdom は今も実装していないので、MouseEvent に pointerId 等を
 * 足しただけのものを置く。clientX / clientY は MouseEvent 側が持っている。
 */
if (!window.PointerEvent) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    readonly isPrimary: boolean

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? ''
      this.isPrimary = init.isPrimary ?? false
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
}

/** useMediaQuery が使う。既定は「広い画面」＝ スマホ用の一覧表示にしない */
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList
}
