import { useCallback, useEffect, useRef, useState } from 'react'
import { isTypingTarget, matchShortcut, toChord } from '../lib/shortcuts'

export interface UndoEntry {
  label: string
  /** 失敗したら throw する。エントリは元のスタックに戻され、もう一度試せる */
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
}

const LIMIT = 50

interface Mark {
  pushed: number
  dropped: number
  cleared: number
  depth: number
}

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
   * 新しい操作の記録（push）は、取り消し・やり直しの保存を待たずにその場でする。
   * 保存が返らない 1 件（止まった回線など）のせいで、あとの操作まで記録されなくなるのを避ける。
   *
   * その代わり、保存を待っているあいだに新しい操作があったかを数で見分ける。
   *   pushedRef  … push のたびに進む。進んでいたら、やり直しの履歴は捨てる決まり
   *   droppedRef … 上限を超えて、取り消しの山の下から捨てた数。戻す位置のずれに使う
   *   clearedRef … clear のたびに進む。進んでいたら、待っていたエントリはどこにも戻さない
   */
  const pushedRef = useRef(0)
  const droppedRef = useRef(0)
  const clearedRef = useRef(0)

  const push = useCallback((entry: UndoEntry) => {
    undoRef.current.push(entry)
    if (undoRef.current.length > LIMIT) {
      undoRef.current.shift()
      droppedRef.current += 1
    }
    redoRef.current = [] // 新しい操作をしたらやり直し履歴は捨てる
    pushedRef.current += 1
    bump()
  }, [])

  /** 待ち始めたときの様子。返ってきたあと、どこへ戻すかを決めるのに使う */
  const mark = useCallback(
    (): Mark => ({
      pushed: pushedRef.current,
      dropped: droppedRef.current,
      cleared: clearedRef.current,
      depth: undoRef.current.length,
    }),
    [],
  )

  /**
   * 取り消しの山の、待ち始めたときの位置へ入れる。あいだに積まれた新しい操作より下になる。
   * 上限を超えてその位置がもう山に無ければ、入れずに捨てる。
   */
  const putBackToUndo = useCallback((entry: UndoEntry, at: Mark) => {
    if (clearedRef.current !== at.cleared) return
    const index = at.depth - (droppedRef.current - at.dropped)
    if (index < 0) return
    undoRef.current.splice(Math.min(index, undoRef.current.length), 0, entry)
    if (undoRef.current.length > LIMIT) {
      undoRef.current.shift()
      droppedRef.current += 1
    }
  }, [])

  /*
   * 取り消し・やり直しそのものは、押した順に 1 つずつ流す。
   *
   * 画面は保存を待たずに戻る（楽観的更新）が、エントリを反対側のスタックへ移すのは
   * 保存が返ってから。順に並べないと、戻った付箋を見てすぐ押したやり直しは
   * 空のスタックを見て捨てられる。並べずに同時に走らせると、同じ行への書き込みが
   * 追い越して、最後に残る状態が押した順と食い違う。
   *
   * 列の尾は、失敗を吸収したものからつなぐ。1 段が投げたまま尾にすると、以後の段が
   * すべて飛ばされ、取り消し・やり直しが黙って効かなくなる。
   */
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const enqueue = useCallback((step: () => Promise<void>) => {
    const next = queueRef.current.then(step)
    queueRef.current = next.catch(() => {})
    return next
  }, [])

  const undo = useCallback(
    () =>
      enqueue(async () => {
        const entry = undoRef.current.pop()
        if (!entry) return
        const at = mark()
        bump()
        try {
          await entry.undo()
        } catch {
          // 保存に失敗した取り消しは「なかったこと」にせず、元の位置に戻す。
          // 理由は各操作が通知で出しているので、ここでは黙って戻すだけ
          putBackToUndo(entry, at)
          bump()
          return
        }
        // あいだに新しい操作をしていたら、やり直しの履歴は捨てる決まりなので積まない
        if (pushedRef.current === at.pushed && clearedRef.current === at.cleared) {
          redoRef.current.push(entry)
        }
        bump()
      }),
    [enqueue, mark, putBackToUndo],
  )

  const redo = useCallback(
    () =>
      enqueue(async () => {
        const entry = redoRef.current.pop()
        if (!entry) return
        const at = mark()
        bump()
        try {
          await entry.redo()
        } catch {
          // あいだに新しい操作をしていたら、やり直しの履歴はもう捨ててある
          if (pushedRef.current === at.pushed && clearedRef.current === at.cleared) {
            redoRef.current.push(entry)
          }
          bump()
          return
        }
        // やり直した操作は、あいだに積まれた新しい操作より下（押した順）に入る
        putBackToUndo(entry, at)
        bump()
      }),
    [enqueue, mark, putBackToUndo],
  )

  const clear = useCallback(() => {
    undoRef.current = []
    redoRef.current = []
    clearedRef.current += 1
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
