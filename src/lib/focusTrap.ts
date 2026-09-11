/**
 * モーダルの中でフォーカスを回すための、要素の拾い方。
 *
 * ここで拾い落とすと Tab が止まるのではなく、「進まなくなる」。
 * Modal.tsx は行き先を計算してから preventDefault するので、
 * 実際にはフォーカスできない要素を行き先に選ぶと、既定の動きも殺したまま
 * 同じ要素を選び続けることになるため。だから「当てても移らないもの」は
 * ここで確実に外す。
 *
 * 見えているかどうかを offsetParent で見ることはできない。jsdom には
 * 配置の計算が無く、常に null になるので、コンポーネントのテストが
 * すべて「フォーカスできる要素なし」になってしまう。代わりに
 * getComputedStyle の display / visibility を見る。jsdom は既定の
 * stylesheet しか持たないため、クラスで消したものはテストでは素通しになるが、
 * それで困るのはブラウザだけなので、効いてほしい側では効く。
 */

const FOCUSABLE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
].join(',')

/**
 * 操作できない状態か。
 *
 * disabled 属性が付いていなくても、fieldset[disabled] の中の入力は
 * 操作できずフォーカスも当たらない（画面では canEdit が false のときの
 * 予定・やることの詳細がこれ）。<legend> の中だけは例外だが、
 * このアプリは legend を使っていないので見ていない。
 */
function isDisabled(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return true
  return el.closest('fieldset[disabled]') !== null
}

/**
 * CSS で消えているか。container まで遡るのは、消えているのが親のときにも
 * 効かせるため（Tailwind の hidden は、囲みのほうに付くことが多い）。
 */
function isHiddenByStyle(el: HTMLElement, container: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return false

  let node: HTMLElement | null = el
  while (node) {
    const style = view.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    if (node === container) return false
    node = node.parentElement
  }
  return false
}

/** container の中で Tab が止まる要素を、文書の順で返す */
export function focusableIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []

  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (isDisabled(el)) return false
    // hidden 属性は既定の stylesheet で display:none になるが、
    // jsdom の既定を当てにしないで、印としても見ておく
    if (el.hidden) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    // tabindex="-1" は「script からは当てられるが Tab では止まらない」
    if (el.getAttribute('tabindex') === '-1') return false
    if (isHiddenByStyle(el, container)) return false
    return true
  })
}

/**
 * Tab / Shift+Tab の行き先。端まで来たら反対の端へ回す。
 *
 * 「いまどこにも当たっていない」ときも端へ寄せる。モーダルの外に
 * フォーカスがあるまま Tab を押すと、背後の画面へ抜けてしまうため。
 * 戻す先が無ければ null（呼び出し側は何もしない）。
 */
export function nextFocus(
  items: HTMLElement[],
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  if (items.length === 0) return null

  const first = items[0]
  const last = items[items.length - 1]
  const index = active instanceof HTMLElement ? items.indexOf(active) : -1

  if (backwards) return index <= 0 ? last : items[index - 1]
  return index === -1 || index === items.length - 1 ? first : items[index + 1]
}
