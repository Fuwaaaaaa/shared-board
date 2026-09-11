import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../lib/errorReport'
import { outboxSnapshot } from '../lib/outboxStore'
import { outboxAsText } from '../lib/outboxText'
import { downloadText } from '../lib/ics'

interface Props {
  children: ReactNode
  /** どこで落ちたか。エラー報告の見分けに使う */
  where: string
  /**
   * 画面いっぱいに出すか、その場に収めるか。
   *
   * 'screen' は root と page 用（落ちた時点で周りに何も残らない）。
   * 'inline' はタブやモーダル用で、ヘッダーが生きたまま残る。
   * そのぶん「もう一度開く」で読み込み直さずに戻れる。
   */
  variant?: 'screen' | 'inline'
}

interface State {
  failed: boolean
  message: string
}

/**
 * 描画の途中で投げられた例外の受け皿。
 *
 * installErrorReporting（lib/errorReport.ts）は window の error と
 * unhandledrejection を拾うが、React の描画中に投げられた例外はそこへ流れず、
 * React が木ごと外して真っ白になる。困るのは見た目より、
 * **オフラインのあいだにためた書き込みへ触れる道が消える**こと——
 * 送信箱は画面の中にしか入口が無い。
 *
 * そこでここでは、件数を出して、中身をテキストに落とせるようにしてある。
 * 落ちたあとに React の部品を積み増すとまた落ちうるので、送信箱の画面は
 * 開かない。読み出しは useSyncExternalStore を通さない outboxSnapshot、
 * 保存は downloadText（DOM だけ）で、壊れた木に寄りかからない。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return {
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    /*
     * 報告そのものが失敗しても、この画面は出し続ける
     * （reportError は中で握りつぶすが、念のため）。
     */
    try {
      const detail = error instanceof Error ? error : new Error(String(error))
      detail.message = `[${this.props.where}] ${detail.message}`
      if (info.componentStack) detail.stack = `${detail.stack ?? ''}\n${info.componentStack}`
      reportError(detail)
    } catch {
      // 何もしない
    }
  }

  /** その場に収めているときだけ。読み込み直さずに、もう一度描いてみる */
  private retry = () => this.setState({ failed: false, message: '' })

  render() {
    if (!this.state.failed) return this.props.children

    // 落ちた時点でためてあったもの。React の購読を通さずに読む
    const entries = outboxSnapshot()
    const inline = this.props.variant === 'inline'

    return (
      <div
        className={
          inline
            ? 'grid h-full place-items-center p-6'
            : 'grid min-h-screen place-items-center bg-slate-50 p-6'
        }
      >
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-2 text-lg font-bold text-slate-800">表示できませんでした</h1>
          <p className="mb-4 text-sm text-slate-600">
            {inline
              ? 'この部分を出す途中で問題が起きました。ほかのタブと、上のボタンはそのまま使えます。'
              : 'この画面を出す途中で問題が起きました。読み込み直すと直ることがあります。'}
          </p>

          {entries.length > 0 && (
            <div className="mb-4 rounded-xl bg-amber-50 p-3">
              <p className="text-sm text-amber-900">
                まだ送っていない書き込みが {entries.length} 件あります。
                送り直す前に、中身を手元に残しておけます。
              </p>
              <button
                type="button"
                onClick={() => downloadText('送信箱.txt', outboxAsText(entries), 'text/plain')}
                className="mt-2 text-xs text-amber-900 underline transition hover:text-amber-950"
              >
                テキストで保存
              </button>
            </div>
          )}

          <div className="flex gap-2">
            {inline && (
              <button
                type="button"
                onClick={this.retry}
                className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
              >
                もう一度開く
              </button>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={
                inline
                  ? 'flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50'
                  : 'w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700'
              }
            >
              読み込み直す
            </button>
          </div>

          {this.state.message && (
            <p className="mt-3 text-center text-xs break-all text-slate-400">
              {this.state.message}
            </p>
          )}
        </div>
      </div>
    )
  }
}
