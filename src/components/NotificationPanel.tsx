import { useMemo, useState } from 'react'
import { format, formatDistanceToNowStrict, isToday, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { NOTIFICATION_ICONS, type AppNotification, type NotificationKind } from '../lib/types'
import type { TabKey } from './RoomHeader'

interface Props {
  notifications: AppNotification[]
  onClose: () => void
  onMarkAllRead: () => void
  onMarkRead: (id: string) => void
  onRemove: (id: string) => void
  onOpen: (tab: TabKey, id: string | null) => void
}

/**
 * 自分あての通知。
 *
 * 開いただけで全部を既読にすると、あとで見返したいものまで消えてしまうので、
 * 既読にするのは「押したもの」と「すべて既読にする」を押したときだけにする。
 */
export default function NotificationPanel({
  notifications,
  onClose,
  onMarkAllRead,
  onMarkRead,
  onRemove,
  onOpen,
}: Props) {
  const [unreadOnly, setUnreadOnly] = useState(false)

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  )

  const visible = unreadOnly ? notifications.filter((n) => !n.read) : notifications

  return (
    <Modal title="通知" onClose={onClose}>
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setUnreadOnly(false)}
          className={`rounded-full px-3 py-1 text-sm transition ${
            unreadOnly
              ? 'border border-slate-200 text-slate-600 hover:bg-slate-50'
              : 'bg-slate-900 text-white'
          }`}
        >
          すべて
        </button>
        <button
          type="button"
          onClick={() => setUnreadOnly(true)}
          className={`rounded-full px-3 py-1 text-sm transition ${
            unreadOnly
              ? 'bg-slate-900 text-white'
              : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          未読{unreadCount > 0 && `（${unreadCount}）`}
        </button>

        {unreadCount > 0 && (
          <button
            type="button"
            onClick={onMarkAllRead}
            className="ml-auto text-sm text-slate-500 transition hover:text-slate-900"
          >
            すべて既読にする
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          {unreadOnly ? (
            '未読の通知はありません。'
          ) : (
            <>
              通知はありません。
              <br />
              チャットやコメントで <code className="rounded bg-slate-100 px-1">@名前</code>{' '}
              と書くと、その人に通知が届きます。
            </>
          )}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((notification) => {
            const at = parseISO(notification.created_at)
            const icon = NOTIFICATION_ICONS[notification.kind as NotificationKind] ?? '🔔'

            return (
              <li
                key={notification.id}
                className={`group rounded-xl border p-3 ${
                  notification.read ? 'border-slate-200' : 'border-slate-900 bg-slate-50'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0">{icon}</span>
                  <span className="text-sm font-medium text-slate-700">
                    {notification.kind === 'digest'
                      ? `ほかに ${notification.folded_count} 件`
                      : notification.actor_name || '誰か'}
                  </span>
                  <span className="text-xs text-slate-400">
                    {isToday(at)
                      ? `${formatDistanceToNowStrict(at, { locale: ja })}前`
                      : format(at, 'M/d(E) HH:mm', { locale: ja })}
                  </span>

                  {!notification.read && (
                    <button
                      type="button"
                      onClick={() => onMarkRead(notification.id)}
                      className="ml-auto shrink-0 text-xs text-slate-400 transition hover:text-slate-800"
                    >
                      既読にする
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(notification.id)}
                    className={`shrink-0 text-xs text-slate-300 transition hover:text-rose-600 ${
                      notification.read ? 'ml-auto' : ''
                    }`}
                  >
                    消す
                  </button>
                </div>

                <p className="mt-1 text-sm whitespace-pre-wrap text-slate-700">
                  {notification.body}
                </p>

                <button
                  type="button"
                  onClick={() => {
                    onMarkRead(notification.id)
                    onOpen(notification.link_tab as TabKey, notification.link_id)
                    onClose()
                  }}
                  className="mt-2 text-xs text-slate-500 transition hover:text-slate-900"
                >
                  → 該当箇所を開く
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
