/*
 * Undo / Redo を、押した順に 1 つずつ流す。
 *
 * 取り消しは画面の側では先に戻る（楽観的更新）が、スタックを動かすのは保存が
 * 返ってから。その隙間に押したやり直しを捨てると、戻った付箋を見て
 * すぐ Ctrl+Shift+Z を押しても何も起きない。回線が遅いほど当たりやすく、
 * 押した側からは「効かなかった」としか見えない。
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useUndoStack, type UndoEntry } from '../useUndoStack'

/** 呼ばれてから、こちらが終わらせる（または失敗させる）まで返らない操作 */
function pending() {
  const notYet = () => {
    throw new Error('まだ呼ばれていない')
  }
  let finish: () => void = notYet
  let fail: () => void = notYet
  const run = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = () => reject(new Error('保存できなかった'))
      }),
  )
  return { run, finish: () => finish(), fail: () => fail() }
}

function entry(patch: Partial<UndoEntry>): UndoEntry {
  return { label: '移動', undo: vi.fn(), redo: vi.fn(), ...patch }
}

describe('useUndoStack', () => {
  it('取り消しの保存が返る前に押したやり直しも、捨てずに後から効く', async () => {
    const { result } = renderHook(() => useUndoStack())
    const undo = pending()
    const redo = vi.fn()
    act(() => result.current.push(entry({ undo: undo.run, redo })))

    let redone: Promise<void> = Promise.resolve()
    act(() => {
      void result.current.undo()
      redone = result.current.redo()
    })
    await act(async () => {})

    // 取り消しの保存がまだ返っていないので、やり直しは待っている
    expect(undo.run).toHaveBeenCalledTimes(1)
    expect(redo).not.toHaveBeenCalled()

    await act(async () => {
      undo.finish()
      await redone
    })
    expect(redo).toHaveBeenCalledTimes(1)
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
  })

  it('続けて押した取り消しは、前の保存が返ってから次を始める', async () => {
    const { result } = renderHook(() => useUndoStack())
    const first = pending()
    const second = pending()
    // 後に積んだほうから取り消される
    act(() => result.current.push(entry({ undo: second.run })))
    act(() => result.current.push(entry({ undo: first.run })))

    let done: Promise<void> = Promise.resolve()
    act(() => {
      void result.current.undo()
      done = result.current.undo()
    })
    await act(async () => {})

    // 同じ付箋への書き込みが追い越すと、最後に残る位置が押した順と食い違う
    expect(first.run).toHaveBeenCalledTimes(1)
    expect(second.run).not.toHaveBeenCalled()

    await act(async () => {
      first.finish()
    })
    expect(second.run).toHaveBeenCalledTimes(1)

    await act(async () => {
      second.finish()
      await done
    })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })

  it('取り消しに失敗したら、続けて押したやり直しは何もしない', async () => {
    const { result } = renderHook(() => useUndoStack())
    const redo = vi.fn()
    act(() =>
      result.current.push(
        entry({
          undo: () => Promise.reject(new Error('保存できなかった')),
          redo,
        }),
      ),
    )

    let redone: Promise<void> = Promise.resolve()
    act(() => {
      void result.current.undo()
      redone = result.current.redo()
    })
    await act(async () => {
      await redone
    })

    // 失敗した取り消しは元のスタックに戻り、やり直す相手はいない
    expect(redo).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
  })

  it('取り消しの保存を待つあいだに新しい操作をしたら、返ってきた取り消しはやり直しに積まない', async () => {
    const { result } = renderHook(() => useUndoStack())
    const undoA = pending()
    const redoA = vi.fn()
    const undoB = vi.fn()
    act(() => result.current.push(entry({ label: 'A', undo: undoA.run, redo: redoA })))

    let undone: Promise<void> = Promise.resolve()
    act(() => {
      undone = result.current.undo()
    })
    await act(async () => {})
    // 取り消した付箋を見て、保存が返る前に別の付箋を動かす
    act(() => result.current.push(entry({ label: 'B', undo: undoB })))

    await act(async () => {
      undoA.finish()
      await undone
    })

    // 新しい操作をしたら、やり直しの履歴は捨てる（A は戻ってこない）
    expect(result.current.canRedo).toBe(false)
    expect(result.current.undoLabel).toBe('B')

    await act(async () => {
      await result.current.redo()
    })
    expect(redoA).not.toHaveBeenCalled()
  })

  it('取り消しに失敗しても、あいだにした新しい操作より上には戻らない', async () => {
    const { result } = renderHook(() => useUndoStack())
    const undoA = pending()
    const undoB = vi.fn()
    act(() => result.current.push(entry({ label: 'A', undo: undoA.run })))

    let undone: Promise<void> = Promise.resolve()
    act(() => {
      undone = result.current.undo()
    })
    await act(async () => {})
    act(() => result.current.push(entry({ label: 'B', undo: undoB })))

    await act(async () => {
      undoA.fail()
      await undone
    })

    // 次の Ctrl+Z は、押した順どおり後からした B を先に取り消す
    expect(result.current.undoLabel).toBe('B')
    await act(async () => {
      await result.current.undo()
    })
    expect(undoB).toHaveBeenCalledTimes(1)
    expect(result.current.undoLabel).toBe('A')
  })
})
