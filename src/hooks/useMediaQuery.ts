import { useCallback, useSyncExternalStore } from 'react'

/**
 * CSS のメディアクエリに追従する。
 * 画面の回転やウィンドウのリサイズで境界をまたいだときに、値が変わって再描画される。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia?.(query)
      if (!media) return () => {}
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    [query],
  )

  const getSnapshot = useCallback(() => window.matchMedia?.(query).matches ?? false, [query])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
