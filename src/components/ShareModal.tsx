import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import Modal from './Modal'
import QrCode from './QrCode'
import { supabase } from '../lib/supabase'
import { ACCESS_MODES, accessMode, visibilityFor, type AccessMode } from '../lib/access'
import type { JoinSettings, RoomPreview } from '../lib/types'

interface Props {
  preview: RoomPreview
  onClose: () => void
  onUpdated: () => void
}

/**
 * 共有リンクまわりの入口。
 *
 * 入り方（リンク公開 / 合言葉つき / 承認制）の切り替えは、名前と実際の状態がずれないよう
 * この画面だけで行う。配ったあとに効く手当て（参加期限・人数上限・受付停止・作り直し・全員を外す）も
 * ここに集める。
 */
export default function ShareModal({ preview, onClose, onUpdated }: Props) {
  const navigate = useNavigate()
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [pinDraft, setPinDraft] = useState(false)
  const [settings, setSettings] = useState<JoinSettings | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [rotateOnRevoke, setRotateOnRevoke] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shareUrl = `${window.location.origin}/r/${preview.slug}`
  const mode = accessMode(preview)

  // 復帰トークンはオーナーしか SELECT できない（RLS）。
  // 合言葉はハッシュしか保存していないので、オーナーにも表示できない
  // （needs_pin で「設定済み」かどうかだけ分かる。入力欄は常に空で始める）。
  useEffect(() => {
    if (!preview.is_owner) return
    let cancelled = false

    void Promise.all([
      supabase
        .from('room_secrets')
        .select('recovery_token')
        .eq('room_id', preview.id)
        .maybeSingle(),
      supabase
        .from('rooms')
        .select('join_closed, join_expires_at, max_members')
        .eq('id', preview.id)
        .maybeSingle(),
    ]).then(([secret, room]) => {
      if (cancelled) return
      if (secret.data) setRecoveryToken(secret.data.recovery_token as string)
      if (room.data) setSettings(room.data as JoinSettings)
    })

    return () => {
      cancelled = true
    }
  }, [preview.id, preview.is_owner])

  /**
   * 入り方を切り替える。
   *
   * 合言葉つきにするには合言葉が要るので、まだ決まっていなければ入力欄だけ開いて止める。
   * 合言葉つき以外へ移るときは合言葉を消す。残しておくと「合言葉つき」の表示と実態がずれる。
   */
  async function changeMode(next: AccessMode, pinValue = pin) {
    // 合言葉つきのままでも、合言葉そのものは付け替えられる
    if (next === mode && next !== 'pin') return

    if (next === 'pin' && !pinValue.trim()) {
      setPinDraft(true)
      return
    }

    setBusy(true)
    setError(null)

    if (next === 'pin') {
      const { error: failed } = await supabase.rpc('set_join_pin', {
        p_room_id: preview.id,
        p_pin: pinValue.trim(),
      })
      if (failed) {
        setError(failed.message)
        setBusy(false)
        return
      }
    } else if (preview.needs_pin || pin) {
      await supabase.rpc('set_join_pin', { p_room_id: preview.id, p_pin: '' })
      setPin('')
    }

    const { error: failed } = await supabase
      .from('rooms')
      .update({ visibility: visibilityFor(next) })
      .eq('id', preview.id)

    if (failed) setError(failed.message)
    else {
      setPinDraft(false)
      onUpdated()
    }
    setBusy(false)
  }

  /** 参加の条件（参加期限・人数・受付停止）。入り方は変えない */
  async function saveSettings(patch: Partial<JoinSettings>) {
    if (!settings) return
    setBusy(true)
    setError(null)

    const { error: failed } = await supabase.from('rooms').update(patch).eq('id', preview.id)

    if (failed) setError(failed.message)
    else setSettings({ ...settings, ...patch })
    setBusy(false)
  }

  async function rotateLink() {
    const ok = window.confirm(
      '新しいリンクを作ります。いまのリンクは開けなくなります。よろしいですか？',
    )
    if (!ok) return

    setBusy(true)
    setError(null)

    const { data, error: failed } = await supabase.rpc('rotate_room_slug', {
      p_room_id: preview.id,
    })

    if (failed) {
      setError(failed.message)
      setBusy(false)
      return
    }
    navigate(`/r/${data as string}`, { replace: true })
  }

  /**
   * いま参加している人を全員外す。
   *
   * リンク公開のままでは URL を知っている人が入り直せてしまうので、
   * サーバー側で必ず承認制（合言葉つきなら合言葉つき）に落としてから外す。
   */
  async function revokeAll() {
    const lines = [
      'いま参加している人を全員外します。',
      '',
      '・このボードはリンク公開ではなくなります',
      rotateOnRevoke ? '・共有リンクも作り直します（古い URL は開けなくなります）' : '',
      '・外された人には「参加が取り消されました」と通知が届きます',
      '・付箋や予定は消えません',
      '',
      'よろしいですか？',
    ].filter(Boolean)

    if (!window.confirm(lines.join('\n'))) return

    setBusy(true)
    setError(null)

    const { data, error: failed } = await supabase.rpc('revoke_all_members', {
      p_room_id: preview.id,
      p_rotate_slug: rotateOnRevoke,
    })

    if (failed) {
      setError(failed.message)
      setBusy(false)
      return
    }

    const nextSlug = data as string
    if (nextSlug && nextSlug !== preview.slug) {
      navigate(`/r/${nextSlug}`, { replace: true })
      return
    }
    onUpdated()
    setBusy(false)
  }

  async function rotateOwnerToken() {
    if (!window.confirm('復帰リンクを作り直します。前のリンクは使えなくなります。')) return

    setBusy(true)
    setError(null)

    const { data, error: failed } = await supabase.rpc('rotate_owner_token', {
      p_room_id: preview.id,
    })

    if (failed) setError(failed.message)
    else setRecoveryToken(data as string)
    setBusy(false)
  }

  const current = ACCESS_MODES.find((m) => m.key === mode)!

  return (
    <Modal title="このボードを共有" onClose={onClose}>
      <div className="space-y-6">
        <div>
          <p className="mb-2 text-sm text-slate-600">
            {current.icon} <span className="font-medium">{current.label}</span>のボードです。
            {current.description}
          </p>
          <CopyField value={shareUrl} label="共有リンクをコピー" />

          <button
            type="button"
            onClick={() => setShowQr((v) => !v)}
            className="mt-2 text-sm text-slate-500 transition hover:text-slate-800"
          >
            {showQr ? '▲ QR コードを閉じる' : '▼ QR コードで見せる'}
          </button>

          {showQr && (
            <div className="mt-3 flex flex-col items-center gap-2 rounded-xl border border-slate-200 p-4">
              <QrCode value={shareUrl} />
              <p className="text-xs text-slate-500">
                その場にいる人は、カメラで読み取ればすぐ参加できます。
              </p>
            </div>
          )}
        </div>

        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

        {preview.is_owner && settings && (
          <>
            <section className="space-y-3 rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-bold text-slate-800">🚪 入り方</h3>

              <div className="space-y-2">
                {ACCESS_MODES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    disabled={busy}
                    onClick={() => void changeMode(option.key)}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${
                      option.key === mode
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    <span className="text-lg">{option.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">
                        {option.label}
                        <span className="ml-2 text-xs font-normal text-slate-400">
                          入り方：{option.howToEnter}
                        </span>
                      </span>
                      <span className="block text-xs text-slate-500">{option.description}</span>
                    </span>
                  </button>
                ))}
              </div>

              {(mode === 'pin' || pinDraft) && (
                <PinRow
                  pin={pin}
                  configured={preview.needs_pin}
                  busy={busy}
                  onChange={setPin}
                  onSave={(value) => changeMode('pin', value)}
                />
              )}
            </section>

            <section className="space-y-4 rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-bold text-slate-800">🔐 参加の条件</h3>

              {mode === 'link' && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                  いまはリンク公開です。URL を知っていれば誰でも中身を読めるので、下の条件は
                  「新しく参加者として登録できるか」しか変えられません。読める人を絞りたいときは、
                  上で合言葉つきか承認制を選んでください。
                </p>
              )}

              <div>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  ⏳ 新しく参加できる期限
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="datetime-local"
                    disabled={busy}
                    value={
                      settings.join_expires_at
                        ? format(parseISO(settings.join_expires_at), "yyyy-MM-dd'T'HH:mm")
                        : ''
                    }
                    onChange={(e) =>
                      void saveSettings({
                        join_expires_at: e.target.value
                          ? new Date(e.target.value).toISOString()
                          : null,
                      })
                    }
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
                  />
                  {settings.join_expires_at && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveSettings({ join_expires_at: null })}
                      className="text-sm text-slate-400 transition hover:text-slate-700"
                    >
                      なくす
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  この日時を過ぎると、新しく参加できなくなります。
                  リンクそのものが使えなくなるわけではないので、いまの参加者はそのまま使えます。
                </p>
              </div>

              <div>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  👥 参加できる人数
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={500}
                    disabled={busy}
                    value={settings.max_members ?? ''}
                    placeholder="制限なし"
                    onChange={(e) =>
                      void saveSettings({
                        max_members: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
                  />
                  <span className="text-sm text-slate-500">人まで</span>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={settings.join_closed}
                  onChange={(e) => void saveSettings({ join_closed: e.target.checked })}
                />
                ⏸ 参加の受付を止める
              </label>

              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void rotateLink()}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  🔄 リンクを作り直す
                </button>
                <p className="mt-1 text-xs text-slate-400">
                  いまのリンクは開けなくなります。すでに参加している人は、新しいリンクから入れます。
                </p>
              </div>
            </section>

            <section className="rounded-xl border border-rose-200 p-4">
              <h3 className="text-sm font-bold text-rose-700">⛔ いったん全員を締め出す</h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-600">
                リンクが知らない人に転送されてしまったときに使います。いま参加している人を全員外し、
                入り方を承認制（合言葉を設定していれば合言葉つき）に切り替えます。
                付箋・予定・やることは消えません。呼び戻したい人には、新しいリンクを送り直してください。
              </p>
              <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={rotateOnRevoke}
                  onChange={(e) => setRotateOnRevoke(e.target.checked)}
                />
                共有リンクも作り直す（おすすめ）
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => void revokeAll()}
                className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
              >
                全員を外す
              </button>
            </section>
          </>
        )}

        {preview.is_owner && recoveryToken && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <h3 className="mb-1 text-sm font-bold text-amber-900">
              ⚠️ オーナー復帰リンク（自分だけで保管）
            </h3>
            <p className="mb-3 text-xs leading-relaxed text-amber-800">
              このサイトはブラウザごとに利用者を識別しています。別のパソコンやブラウザから
              オーナーとして操作したいときや、ブラウザのデータを消してしまったときは、
              下のリンクを開くとオーナー権限を取り戻せます。
              <strong className="font-semibold">他の人には渡さないでください。</strong>
            </p>
            <CopyField
              value={`${shareUrl}?owner=${recoveryToken}`}
              label="復帰リンクをコピー"
              secret
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void rotateOwnerToken()}
              className="mt-2 text-xs text-amber-800 underline transition hover:text-amber-950 disabled:opacity-50"
            >
              復帰リンクを作り直す（漏れてしまったとき）
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

function PinRow({
  pin,
  configured,
  busy,
  onChange,
  onSave,
}: {
  pin: string
  /** すでに合言葉が設定されている（中身は表示できない） */
  configured: boolean
  busy: boolean
  onChange: (value: string) => void
  onSave: (value: string) => Promise<void>
}) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="join-pin">
        🔑 合言葉
      </label>
      {configured && (
        <p className="mb-2 text-xs text-slate-500">
          設定済み（表示はできません）。新しい合言葉を入れると置き換わります。
        </p>
      )}
      <div className="flex gap-2">
        <input
          id="join-pin"
          value={pin}
          maxLength={32}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          placeholder={configured ? '新しい合言葉' : '例：1234 / あいことば'}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
        />
        <button
          type="button"
          disabled={busy || !pin.trim()}
          onClick={() => void onSave(pin)}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
        >
          {configured ? '置き換える' : '保存'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        合言葉を知っている人は、承認を待たずにそのまま参加できます。
        合言葉は暗号化して保存され、あとから見ることはできません。忘れたら新しく設定してください。
      </p>
    </div>
  )
}

function CopyField({
  value,
  label,
  secret = false,
}: {
  value: string
  label: string
  secret?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(!secret)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // クリップボードが使えない環境（http など）では選択してもらう
      window.prompt('下のリンクをコピーしてください', value)
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={revealed ? value : '•'.repeat(40)}
        onFocus={(e) => revealed && e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
      />
      {secret && !revealed && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 transition hover:bg-white"
        >
          表示
        </button>
      )}
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
      >
        {copied ? '✓ コピー済み' : label}
      </button>
    </div>
  )
}
