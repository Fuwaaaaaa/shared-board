/*
 * 読み込み中の受け皿。
 *
 * 画面をページ・タブ・モーダルの単位に分けて、開いたときに取りに行くようにしている
 * （React.lazy）。初めて開くときだけ、ここが一瞬出る。
 *
 * 文言と色は RoomPage の「読み込み中…」に揃えてある。分けたことが
 * 別の見た目として現れないようにするため。
 */
export default function Loading({ full = false }: { full?: boolean }) {
  return (
    <div
      className={
        full
          ? 'grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-400'
          : 'grid h-full place-items-center text-sm text-slate-400'
      }
    >
      読み込み中…
    </div>
  )
}
