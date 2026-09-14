import { useCallback, useEffect, useRef, useState } from 'react'
import { isTypingTarget, matchShortcut, toChord } from '../lib/shortcuts'

export interface UndoEntry {
  label: string
  /** 失敗したら throw する。エントリは元のスタックに戻され、もう一度試せる */
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
}

const LIMIT = 50

/**
 * 自分の操作だけを対象にした Undo / Redo。
 *
 * 共同編集なので「ボード全体を過去の状態に戻す」のではなく、
 * 自分が行った操作の打ち消しだけを積む。
 */
export function useUndoStack() {
  const undoRef = useRef<UndoEntry[]>([])
  const redoRef = useRef<UndoEntry[]>([])
  const [, bumpVersion] = useState(0)
  const bump = () => bumpVersion((v) => v + 1)

  /*
   * 取り消し・やり直しは、押した順に 1 つずつ流す。
   *
   * 画面は保存を待たずに戻る（楽観的更新）が、エントリを反対側のスタックへ移すのは
   * 保存が返ってから。順に並べないと、戻った付箋を見てすぐ押したやり直しは
   * 空のスタックを見て捨てられる。並べずに同時に走らせると、同じ行への書き込みが
   * 追い越して、最後に残る状態が押した順と食い違う。
   */
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const runningRef = useRef(0)
  const enqueue = useCallback((step: () => void | Promise<void>) => {
    runningRef.current += 1
    const next = queueRef.current.then(step).finally(() => {
      runningRef.current -= 1
    })
    queueRef.current = next
    return next
  }, [])

  const push = useCallback(
    (entry: UndoEntry) => {
      const record = () => {
        undoRef.current.push(entry)
        if (undoRef.current.length > LIMIT) undoRef.current.shift()
        redoRef.current = [] // 新しい操作をしたらやり直し履歴は捨てる
        bump()
      }
      // 取り消し・やり直しの保存を待っているあいだの新しい操作は、その後ろに並べる。
      // 先に積むと、あとから返ってきた取り消しがやり直しの山に入り（捨てたはずの
      // 履歴が戻る）、失敗した取り消しは新しい操作の上に戻る（次の Ctrl+Z が押した順を
      // 飛ばす）。何も待っていなければ、今までどおりその場で積む。
      if (runningRef.current === 0) record()
      else void enqueue(record)
    },
    [enqueue],
  )

  const undo = useCallback(
    () =>
      enqueue(async () => {
        const entry = undoRef.current.pop()
        if (!entry) return
        bump()
        try {
          await entry.undo()
        } catch {
          // 保存に失敗した取り消しは「なかったこと」にせず、元のスタックに戻す。
          // 理由は各操作が通知で出しているので、ここでは黙って戻すだけ
          undoRef.current.push(entry)
          bump()
          return
        }
        redoRef.current.push(entry)
        bump()
      }),
    [enqueue],
  )

  const redo = useCallback(
    () =>
      enqueue(async () => {
        const entry = redoRef.current.pop()
        if (!entry) return
        bump()
        try {
          await entry.redo()
        } catch {
          redoRef.current.push(entry)
          bump()
          return
        }
        undoRef.current.push(entry)
        bump()
      }),
    [enqueue],
  )

  const clear = useCallback(() => {
    undoRef.current = []
    redoRef.current = []
    bump()
  }, [])

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return

      const hit = matchShortcut(toChord(e))
      if (hit === 'undo') {
        e.preventDefault()
        void undo()
      } else if (hit === 'redo') {
        e.preventDefault()
        void redo()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  return {
    push,
    undo,
    redo,
    clear,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    undoLabel: undoRef.current[undoRef.current.length - 1]?.label ?? null,
    redoLabel: redoRef.current[redoRef.current.length - 1]?.label ?? null,
  }
}
