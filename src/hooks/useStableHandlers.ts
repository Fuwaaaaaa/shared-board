import { useRef } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (...args: any[]) => unknown>

/**
 * 渡したオブジェクトのキーごとに、identity が変わらない関数を返す。
 *
 * 各関数は呼ばれた時点の最新の実装（最後に渡したもの）へ委譲するので、
 * 子コンポーネントを memo 化しても、毎回作り直されるクロージャのせいで
 * 再描画されることがなくなる。
 *
 * 前提: キーの集合は最初の呼び出しで固定。あとから増えたキーは無視される。
 * （条件によって関数を出し分けたい場合は、関数の中で分岐する）
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latestRef = useRef(handlers)
  latestRef.current = handlers

  const stableRef = useRef<T | null>(null)
  if (!stableRef.current) {
    const stable: Record<string, (...args: unknown[]) => unknown> = {}
    for (const key of Object.keys(handlers)) {
      stable[key] = (...args: unknown[]) => latestRef.current[key](...args)
    }
    stableRef.current = stable as T
  }
  return stableRef.current
}
