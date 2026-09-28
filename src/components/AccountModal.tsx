import { useEffect, useState } from 'react'
import Modal from './Modal'
import { ensureSession, supabase } from '../lib/supabase'
import { getCaptchaToken } from '../lib/captcha'
import { useIdentity } from '../lib/identity'
import { messageOf } from '../lib/errorMessage'

type Mode = 'idle' | 'confirm' | 'linking' | 'sent' | 'signin' | 'signin-sent'

interface RelatedRoom {
  id: string
  name: string
  /** 自分が作ったボード（delete_my_account(true) で中身ごと消える） */
  mine: boolean
}

/**
 * 端末の引き継ぎ（任意）。
 *
 * このサイトはブラウザごとに利用者を見分けているので、パソコンを買い替えると
 * 別人になってしまう。メールアドレスを結びつけておくと、同じ「自分」のまま
 * 別の端末から入れる。ログインを必須にはしない。
 *
 * 結びつけたあとで気が変わることもあるので、切り離しとデータの削除も同じ場所に置く。
 */
export default function AccountModal({ onClose }: { onClose: () => void }) {
  const { userId } = useIdentity()
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState<Mode>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** null のあいだは読み込み中（読めなかったときも null のまま。消すボタンは押せない） */
  const [rooms, setRooms] = useState<RelatedRoom[] | null>(null)
  const [roomsError, setRoomsError] = useState<string | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteOwned, setDeleteOwned] = useState(false)

  useEffect(() => {
    let cancelled = false
    void supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setLinkedEmail(data.user?.email ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 消す前に「何が消えるのか」を見せる。ボード名が分からないと判断できない。
   *
   * 作ったボードは rooms.owner_id で引く。delete_my_account が消すのもこの集合。
   * 以前は名簿の role で見分けていたが、名簿を自分の行に絞っていなかったので、
   * 参加しているだけのボードでもオーナーの行が返り、「作った人」と出ていた。
   * 取り消されたボード（rejected）は退会しても残る記録なので、一覧には出さない。
   */
  async function loadRooms() {
    setRooms(null)
    setRoomsError(null)

    const [owned, joined] = await Promise.all([
      supabase
        .from('rooms')
        .select('id, name')
        .eq('owner_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('room_members')
        .select('rooms(id, name)')
        .eq('user_id', userId)
        .neq('status', 'rejected')
        .order('created_at', { ascending: false }),
    ])

    const failed = owned.error ?? joined.error
    if (failed) {
      setRoomsError(failed.message)
      return
    }

    const list: RelatedRoom[] = ((owned.data ?? []) as { id: string; name: string }[]).map(
      (room) => ({ ...room, mine: true }),
    )
    const seen = new Set(list.map((room) => room.id))
    for (const row of joined.data ?? []) {
      const room = (row as unknown as { rooms: { id: string; name: string } | null }).rooms
      if (!room || seen.has(room.id)) continue
      seen.add(room.id)
      list.push({ ...room, mine: false })
    }

    setRooms(list)
  }

  /** いまの「自分」にメールアドレスを結びつける。参加者 ID は変わらない。 */
  async function link() {
    const trimmed = email.trim()
    if (!trimmed) return

    setMode('linking')
    setError(null)

    const { error: failed } = await supabase.auth.updateUser({ email: trimmed })
    if (failed) {
      setError(failed.message)
      setMode('idle')
      return
    }
    setMode('sent')
  }

  /** 別の端末で、結びつけたメールアドレスから入り直す */
  async function signIn() {
    const trimmed = email.trim()
    if (!trimmed) return

    setMode('signin')
    setError(null)

    // Supabase 側で CAPTCHA を必須にしていると、captchaToken なしの signInWithOtp は
    // 必ず失敗する。CAPTCHA を使わない設定なら getCaptchaToken() は null を返すので、
    // どちらの設定でもこのまま動く。
    // （CAPTCHA 無しのメール送信は、宛先を変えながら叩けばメール爆撃にも使える）
    let captchaToken: string | null
    try {
      captchaToken = await getCaptchaToken()
    } catch (e) {
      setError(messageOf(e))
      setMode('idle')
      return
    }

    const { error: failed } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
        ...(captchaToken ? { captchaToken } : {}),
      },
    })
    if (failed) {
      setError(failed.message)
      setMode('idle')
      return
    }
    setMode('signin-sent')
  }

  /**
   * この端末をメールから切り離す。
   *
   * サインアウトして匿名で入り直すので、この端末は「別の人」になる。
   * ボードのデータは消えない。戻りたいときは同じアドレスで入り直す。
   */
  async function unlink() {
    const ok = window.confirm(
      'この端末をメールアドレスから切り離します。\n\n' +
        '・この端末は新しい「別の人」として扱われます\n' +
        '・参加中のボードは、この端末からは一覧に出なくなります\n' +
        '・ボードの中身（付箋・予定・やること）は消えません\n' +
        '・同じアドレスで入り直せば、元の自分に戻れます\n\n' +
        'よろしいですか？',
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    try {
      await supabase.auth.signOut()
      await ensureSession()
      window.location.reload()
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  /** 自分の参加記録・通知を消す。オーナーのボードごと消すかは選ぶ */
  async function deleteData() {
    // 一覧を読み終えるまでは消さない。何が消えるかを見せないまま消すことになる
    if (rooms === null) return

    const owned = rooms.filter((r) => r.mine)
    // 確認に出した文言と、実際にすることを必ず揃える
    const withOwned = deleteOwned && owned.length > 0
    const lines = [
      '自分のデータを消します。',
      '',
      '・参加中のボードから抜けます',
      '・受け取ったお知らせを消します',
      withOwned
        ? `・あなたが作ったボード ${owned.length} 件も、中身ごと消します：\n　　${owned
            .map((r) => r.name)
            .join('、')}\n　（ほかの参加者が書いたものも一緒に消えます）`
        : '・あなたが作ったボードは残ります',
      '',
      'この操作は取り消せません。よろしいですか？',
    ].filter(Boolean)

    if (!window.confirm(lines.join('\n'))) return

    setBusy(true)
    setError(null)

    const { error: failed } = await supabase.rpc('delete_my_account', {
      p_delete_owned: withOwned,
    })

    if (failed) {
      setError(failed.message)
      setBusy(false)
      return
    }

    await supabase.auth.signOut()
    await ensureSession()
    window.location.href = '/'
  }

  return (
    <Modal title="ほかの端末でも使う" onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-slate-600">
          ふだんは名前を入れるだけで使えます。
          パソコンを買い替えたときや、スマホでも同じ自分として使いたいときだけ、
          メールアドレスを結びつけてください。
        </p>

        {linkedEmail ? (
          <div className="rounded-xl border border-green-200 bg-green-50 p-4">
            <p className="text-sm font-medium text-green-900">
              ✅ {linkedEmail} と結びついています
            </p>
            <p className="mt-1 text-xs text-green-800">
              別の端末では、下の「別の端末から入る」に同じアドレスを入れてください。
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void unlink()}
              className="mt-3 text-xs text-green-900 underline transition hover:text-green-950 disabled:opacity-50"
            >
              この端末をメールから切り離す
            </button>
          </div>
        ) : (
          <section>
            <h3 className="mb-2 text-sm font-bold text-slate-800">この端末を引き継げるようにする</h3>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
              />
              <button
                type="button"
                disabled={mode === 'linking' || !email.trim()}
                onClick={() => setMode('confirm')}
                className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
              >
                {mode === 'linking' ? '送信中…' : '結びつける'}
              </button>
            </div>

            {/* 何が起きるのかを、送る前に一度だけ見せる */}
            {mode === 'confirm' && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                <p className="mb-2 font-medium text-slate-800">確認してください</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>{email.trim()} に確認メールを送ります。リンクを開くと結びつきます</li>
                  <li>表示名も、いま参加しているボードもそのままです</li>
                  <li>ログインが必要になるわけではありません。今までどおり使えます</li>
                  <li>あとから「切り離す」で元に戻せます</li>
                </ul>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void link()}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-white transition hover:bg-slate-700"
                  >
                    確認メールを送る
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('idle')}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 transition hover:bg-white"
                  >
                    やめる
                  </button>
                </div>
              </div>
            )}

            <p className="mt-1.5 text-xs text-slate-400">
              いま参加しているボードや、あなたが作ったものはそのまま引き継がれます。
            </p>
            {mode === 'sent' && (
              <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
                確認メールを送りました。メール内のリンクを開くと結びつきます。
              </p>
            )}
          </section>
        )}

        <section className="border-t border-slate-100 pt-5">
          <h3 className="mb-2 text-sm font-bold text-slate-800">別の端末から入る</h3>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="結びつけたアドレス"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            />
            <button
              type="button"
              disabled={mode === 'signin' || !email.trim()}
              onClick={() => void signIn()}
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {mode === 'signin' ? '送信中…' : 'ログイン用のメールを送る'}
            </button>
          </div>
          {mode === 'signin-sent' && (
            <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
              メールを送りました。リンクを開くと、この端末が同じ自分になります。
            </p>
          )}
        </section>

        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

        <section className="border-t border-slate-100 pt-5">
          {showDelete ? (
            <div className="rounded-xl border border-rose-200 p-4">
              <h3 className="text-sm font-bold text-rose-700">自分のデータを消す</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                参加記録とお知らせを消します。下の一覧が、いまあなたに関係しているボードです。
              </p>

              <ul className="mt-3 max-h-32 space-y-1 overflow-auto text-xs text-slate-600">
                {roomsError ? (
                  <li className="text-rose-700">
                    ボードの一覧を読めませんでした（{roomsError}）。開き直してお試しください。
                  </li>
                ) : rooms === null ? (
                  <li className="text-slate-400">読み込み中…</li>
                ) : (
                  rooms.length === 0 && <li className="text-slate-400">ボードはありません</li>
                )}
                {(rooms ?? []).map((room) => (
                  <li key={room.id} className="flex items-center gap-2">
                    <span className="truncate">{room.name}</span>
                    {room.mine && (
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                        作った人
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <label className="mt-3 flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={deleteOwned}
                  onChange={(e) => setDeleteOwned(e.target.checked)}
                />
                <span>
                  自分が作ったボードも、中身ごと消す
                  <span className="block text-slate-400">
                    ほかの参加者が書いた付箋・予定・やることも一緒に消えます。
                  </span>
                </span>
              </label>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy || rooms === null}
                  onClick={() => void deleteData()}
                  className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                >
                  消す
                </button>
                <button
                  type="button"
                  onClick={() => setShowDelete(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
                >
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setShowDelete(true)
                void loadRooms()
              }}
              className="text-xs text-slate-400 underline transition hover:text-rose-600"
            >
              自分のデータを消す
            </button>
          )}
        </section>

        <p className="border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-400">
          この機能を使うには、Supabase の Authentication で Email を有効にしておく必要があります。
          手順は docs/SETUP.md にあります。
        </p>
      </div>
    </Modal>
  )
}
