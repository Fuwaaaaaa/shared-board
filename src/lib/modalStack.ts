/**
 * 開いているモーダルの重なり順。
 *
 * Esc やショートカットを「最前面のモーダルだけ」が受け取れるようにするための
 * ごく小さな台帳。Modal コンポーネントがマウント時に登録し、アンマウントで外す。
 * 画面上のホットキー（ホワイトボードの Delete など）は hasOpenModal() で黙る。
 */
const stack: symbol[] = []

export function registerModal(): { isTop: () => boolean; unregister: () => void } {
  const token = Symbol('modal')
  stack.push(token)
  return {
    isTop: () => stack[stack.length - 1] === token,
    unregister: () => {
      const index = stack.indexOf(token)
      if (index !== -1) stack.splice(index, 1)
    },
  }
}

export function hasOpenModal(): boolean {
  return stack.length > 0
}
