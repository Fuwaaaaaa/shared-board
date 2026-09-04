import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { generateSlug, supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { ThemeToggle } from '../lib/theme'
import { usePwa } from '../hooks/usePwa'
import { BOARD_TEMPLATES } from '../lib/templates'
import { ACCESS_MODES, checkPin, visibilityFor, type AccessMode } from '../lib/access'
import AccountModal from '../components/AccountModal'
import type { Note, Room } from '../lib/types'
import { messageOf } from '../lib/errorMessage'

interface JoinedRoom {
  memberId: string
  room: Room
  status: string
  role: string
  favorite: boolean
}

export default function HomePage() {
  const { userId, displayName, setDisplayName } = useIdentity()
  const navigate = useNavigate()
  const pwa = usePwa()

  const [rooms, setRooms] = useState<JoinedRoom[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<AccessMode>('link')
  const [pin, setPin] = useState('')
  const [templateKey, setTemplateKey] = useState('blank')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showAccount, setShowAccount] = useState(false)

  const active = rooms.filter((r) => !r.room.archived)
  const archived = rooms.filter((r) => r.room.archived)

  /** お気に入りは参加者ごとの設定なので room_members 側に持つ */
  async function toggleFavorite(entry: JoinedRoom) {
    const next = !entry.favorite
    setRooms((current) =>
      current.map((r) => (r.memberId === entry.memberId ? { ...r, favorite: next } : r)),
    )
    await supabase.from('room_members').update({ favorite: next }).eq('id', entry.memberId)
  }

  /**
   * ボードの終了 / 再開。ボード全体の設定なので、オーナーだけが変えられる。
   * 終了すると中身は読めるまま、新しい書き込みだけが止まる（サーバー側で判定）。
   */
  async function toggleArchive(entry: JoinedRoom) {
    if (entry.role !== 'owner') return
    const next = !entry.room.archived

    if (next) {
      const ok = window.confirm(
        `「${entry.room.name}」を終了します。` +
          '中身はそのまま読めますが、新しい書き込みはできなくなります。',
      )
      if (!ok) return
    }

    setRooms((current) =>
      current.map((r) =>
        r.memberId === entry.memberId ? { ...r, room: { ...r.room, archived: next } } : r,
      ),
    )
    await supabase.from('rooms').update({ archived: next }).eq('id', entry.room.id)
  }

  useEffect(() => {
    let cancelled = false
    supabase
      .from('room_members')
      .select('id, status, role, favorite, rooms(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return
        const list = (data ?? [])
          .map((row) => {
            const r = row as unknown as {
              id: string
              status: string
              role: string
              favorite: boolean
              rooms: Room | null
            }
            return r.rooms
              ? {
                  memberId: r.id,
                  room: r.rooms,
                  status: r.status,
                  role: r.role,
                  favorite: Boolean(r.favorite),
                }
              : null
          })
          .filter((v): v is JoinedRoom => v !== null)
        setRooms(list)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  async function createRoom(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || creating) return
    if (mode === 'pin') {
      const problem = checkPin(pin)
      if (problem) {
        setError(problem)
        return
      }
    }

    setCreating(true)
    setError(null)
    try {
      const slug = generateSlug()
      const { data: room, error: roomError } = await supabase
        .from('rooms')
        .insert({
          slug,
          name: trimmed,
          visibility: visibilityFor(mode),
          owner_id: userId,
          owner_name: displayName,
        })
        .select()
        .single()
      if (roomError) throw roomError

      // 合言葉は rooms ではなく room_secrets に入るので、作成後に RPC で設定する
      if (mode === 'pin') {
        const { error: pinError } = await supabase.rpc('set_join_pin', {
          p_room_id: (room as Room).id,
          p_pin: pin.trim(),
        })
        if (pinError) throw pinError
      }

      // 作成者を承認済みオーナーとして登録
      const { error: memberError } = await supabase.from('room_members').insert({
        room_id: (room as Room).id,
        user_id: userId,
        display_name: displayName,
        role: 'owner',
        status: 'approved',
        can_edit: true,
      })
      if (memberError) throw memberError

      // テンプレートを選んでいれば、最初の付箋を置いておく
      const template = BOARD_TEMPLATES.find((t) => t.key === templateKey)
      if (template && template.items.length > 0) {
        const now = new Date().toISOString()
        const rows: Note[] = template.items.map((item, index) => ({
          id: crypto.randomUUID(),
          room_id: (room as Room).id,
          kind: item.kind,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          color: item.color,
          text: item.text,
          tags: [],
          z: index + 1,
          font_size: 0,
          deleted_at: null,
          author_id: userId,
          author_name: displayName,
          created_at: now,
          updated_at: now,
        }))
        await supabase.from('notes').insert(rows)
      }

      navigate(`/r/${slug}?created=1`)
    } catch (e) {
      setError(messageOf(e))
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🗂️</span>
            <span className="font-bold text-slate-800">みんなのボード</span>
          </div>
          <div className="flex items-center gap-2">
            {pwa.canInstall && (
              <button
                type="button"
                onClick={() => void pwa.install()}
                title="ホーム画面に追加する"
                className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
              >
                📲 <span className="hidden sm:inline">インストール</span>
              </button>
            )}
            <ThemeToggle />
            <button
              type="button"
              title="ほかの端末でも使う"
              onClick={() => setShowAccount(true)}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              📱
            </button>
            <button
              type="button"
              onClick={() => {
                const next = window.prompt('表示名を変更', displayName)
                if (next?.trim()) setDisplayName(next)
              }}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              👤 {displayName}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <section className="mb-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-bold text-slate-800">新しいボードを作る</h1>
          <p className="mb-5 text-sm text-slate-500">
            作ったあとに出てくる URL を共有すれば、すぐ一緒に使えます。
          </p>

          <form onSubmit={createRoom} className="space-y-4">
            <input
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="ボード名（例：開発チーム / 家族の予定）"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
            />

            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">入り方</span>
              <div className="grid gap-3 sm:grid-cols-3">
                {ACCESS_MODES.map((option) => (
                  <AccessOption
                    key={option.key}
                    selected={mode === option.key}
                    onSelect={() => setMode(option.key)}
                    icon={option.icon}
                    title={option.label}
                    description={option.description}
                  />
                ))}
              </div>
              {mode === 'pin' && (
                <input
                  value={pin}
                  maxLength={32}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="合言葉（6 文字以上。例：あきまつり2026）"
                  className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
                />
              )}
              <p className="mt-1.5 text-xs text-slate-500">
                あとから共有画面で変えられます。
              </p>
            </div>

            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                最初のレイアウト
              </span>
              <div className="flex flex-wrap gap-2">
                {BOARD_TEMPLATES.map((template) => (
                  <button
                    key={template.key}
                    type="button"
                    title={template.description}
                    onClick={() => setTemplateKey(template.key)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                      templateKey === template.key
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 text-slate-600 hover:border-slate-400'
                    }`}
                  >
                    {template.name}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                {BOARD_TEMPLATES.find((t) => t.key === templateKey)?.description}
              </p>
            </div>

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
            )}

            <button
              type="submit"
              disabled={!name.trim() || creating}
              className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {creating ? '作成中…' : 'ボードを作成'}
            </button>
          </form>
        </section>

        {loading ? (
          <p className="text-sm text-slate-400">読み込み中…</p>
        ) : rooms.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
            まだ参加しているボードはありません。
          </p>
        ) : (
          <div className="space-y-8">
            <RoomSection
              title="お気に入り"
              rooms={active.filter((r) => r.favorite)}
              onToggleFavorite={toggleFavorite}
              onToggleArchive={toggleArchive}
            />
            <RoomSection
              title="参加中のボード"
              rooms={active.filter((r) => !r.favorite)}
              onToggleFavorite={toggleFavorite}
              onToggleArchive={toggleArchive}
            />
            {archived.length > 0 && (
              <section>
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="mb-3 text-sm font-bold tracking-wide text-slate-500 transition hover:text-slate-800"
                >
                  {showArchived ? '▼' : '▶'} 終了したボード（{archived.length}）
                </button>
                {showArchived && (
                  <RoomSection
                    title=""
                    rooms={archived}
                    onToggleFavorite={toggleFavorite}
                    onToggleArchive={toggleArchive}
                  />
                )}
              </section>
            )}
          </div>
        )}
      </main>

      {showAccount && <AccountModal onClose={() => setShowAccount(false)} />}
    </div>
  )
}

function RoomSection({
  title,
  rooms,
  onToggleFavorite,
  onToggleArchive,
}: {
  title: string
  rooms: JoinedRoom[]
  onToggleFavorite: (entry: JoinedRoom) => void
  onToggleArchive: (entry: JoinedRoom) => void
}) {
  if (rooms.length === 0) return null

  return (
    <section>
      {title && (
        <h2 className="mb-3 text-sm font-bold tracking-wide text-slate-500">{title}</h2>
      )}
      <ul className="space-y-2">
        {rooms.map((entry) => (
          <li
            key={entry.memberId}
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 transition hover:border-slate-400"
          >
            <button
              type="button"
              title={entry.favorite ? 'お気に入りから外す' : 'お気に入りに入れる'}
              onClick={() => onToggleFavorite(entry)}
              className={`shrink-0 rounded p-1 text-lg transition ${
                entry.favorite ? 'text-amber-400' : 'text-slate-200 hover:text-slate-400'
              }`}
            >
              ★
            </button>

            <Link to={`/r/${entry.room.slug}`} className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-slate-800">{entry.room.name}</span>
                {entry.room.visibility === 'private' && (
                  <span
                    title="リンクだけでは入れないボード（合言葉つき / 承認制）"
                    className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500"
                  >
                    🔒
                  </span>
                )}
                {entry.role === 'owner' && (
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                    オーナー
                  </span>
                )}
                {entry.room.archived && (
                  <span
                    title="終了したボード。読めますが書き込めません"
                    className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600"
                  >
                    🔚 終了
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">作成者: {entry.room.owner_name}</p>
            </Link>

            {entry.status === 'pending' && (
              <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                承認待ち
              </span>
            )}
            {entry.status === 'rejected' && (
              <span className="shrink-0 rounded-full bg-rose-50 px-2.5 py-1 text-xs text-rose-700">
                参加できません
              </span>
            )}

            {entry.role === 'owner' && (
              <button
                type="button"
                onClick={() => onToggleArchive(entry)}
                className="shrink-0 text-xs text-slate-400 transition hover:text-slate-800"
              >
                {entry.room.archived ? '再開' : '終了'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function AccessOption({
  selected,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean
  onSelect: () => void
  icon: string
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-4 text-left transition ${
        selected
          ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
          : 'border-slate-200 hover:border-slate-400'
      }`}
    >
      <div className="font-medium text-slate-800">
        {icon} {title}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{description}</p>
    </button>
  )
}
