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

  const push = useCallback((entry: UndoEntry) => {
    undoRef.current.push(entry)
    if (undoRef.current.length > LIMIT) undoRef.current.shift()
    redoRef.current = [] // 新しい操作をしたらやり直し履歴は捨てる
    bump()
  }, [])

  const undo = useCallback(async () => {
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
  }, [])

  const redo = useCallback(async () => {
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
  }, [])

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
