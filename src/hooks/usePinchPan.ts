import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

interface Options {
  zoom: number
  setZoom: (zoom: number) => void
  min: number
  max: number
  enabled: boolean
  /**
   * 2 本目の指が触れた瞬間に呼ぶ。
   * 1 本目で始まっていた操作（付箋のドラッグ・範囲選択・描画）を取り消してもらう。
   */
  onGestureStart: () => void
}

interface Gesture {
  /** 指の中心の下にあったボード座標（ズーム前の論理座標） */
  boardX: number
  boardY: number
  startDistance: number
  startZoom: number
}

interface Pending {
  boardX: number
  boardY: number
  centerX: number
  centerY: number
}

/**
 * 2 本指でのパン / ピンチズーム。
 *
 * capture フェーズで touch のポインタを数え、2 本になったら以後（全部の指が離れるまで）
 * pointermove をレイヤーに届かせない。1 本指は今までどおり各レイヤーが扱う。
 * ズームは React の state なので、指の中心を保つスクロール補正は描画後（useLayoutEffect）に行う。
 */
export function usePinchPan(ref: RefObject<HTMLElement>, options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const gestureRef = useRef<Gesture | null>(null)
  /** 2 本になったあと、全部の指が離れるまで true。1 本になっても付箋を動かし始めない */
  const blockingRef = useRef(false)
  const pendingRef = useRef<Pending | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element || !options.enabled) return

    const pointers = pointersRef.current

    const center = () => {
      const list = [...pointers.values()]
      const rect = element.getBoundingClientRect()
      return {
        x: (list[0].x + list[1].x) / 2 - rect.left,
        y: (list[0].y + list[1].y) / 2 - rect.top,
        distance: Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y),
      }
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size !== 2) return

      const { x, y, distance } = center()
      const zoom = optionsRef.current.zoom
      gestureRef.current = {
        boardX: (element.scrollLeft + x) / zoom,
        boardY: (element.scrollTop + y) / zoom,
        startDistance: Math.max(1, distance),
        startZoom: zoom,
      }
      blockingRef.current = true
      optionsRef.current.onGestureStart()
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (!blockingRef.current) return
      e.stopPropagation()

      const gesture = gestureRef.current
      if (!gesture || pointers.size < 2) return

      const { x, y, distance } = center()
      const { min, max, zoom, setZoom } = optionsRef.current
      const next = Math.min(
        max,
        Math.max(min, +((gesture.startZoom * distance) / gesture.startDistance).toFixed(2)),
      )

      if (next === zoom) {
        // ズームが変わらないなら、その場でスクロールだけ動かす
        element.scrollLeft = gesture.boardX * zoom - x
        element.scrollTop = gesture.boardY * zoom - y
        return
      }
      // ズームが変わるときは、DOM に反映されたあとで補正する
      pendingRef.current = { boardX: gesture.boardX, boardY: gesture.boardY, centerX: x, centerY: y }
      setZoom(next)
    }

    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      pointers.delete(e.pointerId)
      if (pointers.size < 2) gestureRef.current = null
      if (pointers.size === 0) blockingRef.current = false
    }

    element.addEventListener('pointerdown', onDown, { capture: true })
    element.addEventListener('pointermove', onMove, { capture: true })
    element.addEventListener('pointerup', onUp, { capture: true })
    element.addEventListener('pointercancel', onUp, { capture: true })
    return () => {
      element.removeEventListener('pointerdown', onDown, { capture: true })
      element.removeEventListener('pointermove', onMove, { capture: true })
      element.removeEventListener('pointerup', onUp, { capture: true })
      element.removeEventListener('pointercancel', onUp, { capture: true })
      pointers.clear()
      gestureRef.current = null
      blockingRef.current = false
    }
    // ref.current は enabled の切り替え（一覧 ↔ ボード）と同時に付け替わる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, options.enabled])

  // ズームが DOM に反映された直後に、指の中心の下にあった点を同じ画面位置へ戻す
  useLayoutEffect(() => {
    const pending = pendingRef.current
    const element = ref.current
    if (!pending || !element) return
    pendingRef.current = null
    element.scrollLeft = pending.boardX * options.zoom - pending.centerX
    element.scrollTop = pending.boardY * options.zoom - pending.centerY
  }, [options.zoom, ref])
}
