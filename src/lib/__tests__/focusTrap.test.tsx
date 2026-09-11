import { describe, expect, it, beforeEach } from 'vitest'
import { focusableIn, nextFocus } from '../focusTrap'

function build(html: string): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  document.body.append(box)
  return box
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('focusableIn', () => {
  it('文書の順で拾う', () => {
    const box = build(`
      <button id="a">A</button>
      <a id="b" href="#">B</a>
      <input id="c" />
      <select id="d"></select>
      <textarea id="e"></textarea>
    `)
    expect(focusableIn(box).map((el) => el.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('押せない・隠したものは拾わない', () => {
    const box = build(`
      <button id="a">A</button>
      <button id="b" disabled>B</button>
      <button id="c" hidden>C</button>
      <button id="d" aria-hidden="true">D</button>
      <div id="e" tabindex="-1">E</div>
    `)
    expect(focusableIn(box).map((el) => el.id)).toEqual(['a'])
  })

  it('tabindex を付けた要素は拾う（-1 以外）', () => {
    const box = build('<div id="a" tabindex="0">A</div>')
    expect(focusableIn(box).map((el) => el.id)).toEqual(['a'])
  })

  it('href の無い a は拾わない（Tab で止まらないため）', () => {
    const box = build('<a id="a">A</a><a id="b" href="#">B</a>')
    expect(focusableIn(box).map((el) => el.id)).toEqual(['b'])
  })

  /*
   * Tailwind の hidden は class で display:none にする。属性ではないので、
   * 印だけを見ていると拾ってしまい、「当てても移らない要素」が Tab の行き先に入る。
   * Modal は行き先を決めてから preventDefault するので、そうなると Tab が
   * 二度と進まなくなる（書き出し・取り込みの隠し file input が実際にこれだった）。
   */
  it('class で display:none にしたものは拾わない', () => {
    const box = build(`
      <style>.hidden { display: none }</style>
      <button id="a">A</button>
      <input id="b" class="hidden" type="file" />
      <button id="c">C</button>
    `)
    expect(focusableIn(box).map((el) => el.id)).toEqual(['a', 'c'])
  })

  it('消えているのが親でも、中のものは拾わない', () => {
    const box = build(`
      <button id="a">A</button>
      <div style="display: none"><button id="b">B</button></div>
      <div style="visibility: hidden"><button id="c">C</button></div>
    `)
    expect(focusableIn(box).map((el) => el.id)).toEqual(['a'])
  })

  /*
   * fieldset[disabled] の中の入力は、自分に disabled が付かないまま操作できなくなる。
   * 閲覧のみの人が予定・やることの詳細を開くとこの形になる。
   */
  it('fieldset[disabled] の中は拾わない', () => {
    const box = build(`
      <button id="a">A</button>
      <fieldset disabled>
        <input id="b" />
        <button id="c">C</button>
      </fieldset>
    `)
    expect(focusableIn(box).map((el) => el.id)).toEqual(['a'])
  })

  it('中身が無ければ空', () => {
    expect(focusableIn(build('<p>ただの文</p>'))).toEqual([])
    expect(focusableIn(null)).toEqual([])
  })
})

describe('nextFocus', () => {
  const items = ['a', 'b', 'c'].map((id) => {
    const el = document.createElement('button')
    el.id = id
    return el
  })
  const [a, b, c] = items

  it('前へ進む', () => {
    expect(nextFocus(items, a, false)).toBe(b)
    expect(nextFocus(items, b, false)).toBe(c)
  })

  it('末尾から先頭へ回る', () => {
    expect(nextFocus(items, c, false)).toBe(a)
  })

  it('Shift+Tab は逆に回る', () => {
    expect(nextFocus(items, c, true)).toBe(b)
    expect(nextFocus(items, a, true)).toBe(c)
  })

  /*
   * モーダルの外にフォーカスがあるまま Tab を押したときも中へ引き戻す。
   * 引き戻さないと、背後の画面のボタンへ順に抜けていく。
   */
  it('外に当たっているときは端へ寄せる', () => {
    const outside = document.createElement('button')
    expect(nextFocus(items, outside, false)).toBe(a)
    expect(nextFocus(items, outside, true)).toBe(c)
    expect(nextFocus(items, null, false)).toBe(a)
  })

  it('中に何も無ければ null', () => {
    expect(nextFocus([], a, false)).toBeNull()
  })
})
