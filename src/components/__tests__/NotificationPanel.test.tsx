/*
 * 通知の一覧。
 *
 * ここで見たいのは「まとめ（digest）の行が、まとめとして読めるか」。
 *
 * digest は人が作る通知ではなく、流量の上限を超えたときに DB 側が作る行
 * （schema.sql の tg_throttle_notifications）。件数は body ではなく
 * folded_count に入っているので、そこを読んで出さないと
 * 「通知が続いたため、まとめています」とだけ出て、何件ぶんか分からない。
 *
 * DB 側の作りは pgTAP が見ている。こちらは画面側の読み取りだけを見る。
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import NotificationPanel from '../NotificationPanel'
import type { AppNotification } from '../../lib/types'

function notification(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    room_id: 'r1',
    user_id: 'u1',
    actor_name: 'けいこ',
    kind: 'mention',
    body: '@みなみ 明日の持ち物どうする？',
    link_tab: 'board',
    link_id: null,
    read: false,
    created_at: new Date().toISOString(),
    folded_count: 0,
    ...over,
  }
}

function show(notifications: AppNotification[]) {
  render(
    <NotificationPanel
      notifications={notifications}
      onClose={() => {}}
      onMarkAllRead={() => {}}
      onMarkRead={() => {}}
      onRemove={() => {}}
      onOpen={() => {}}
    />,
  )
}

describe('NotificationPanel — まとめの行', () => {
  it('ふつうの通知は、差出人の名前で出る', () => {
    show([notification()])
    expect(screen.getByText('けいこ')).toBeInTheDocument()
    expect(screen.getByText('@みなみ 明日の持ち物どうする？')).toBeInTheDocument()
  })

  it('まとめの行は、件数つきで出る', () => {
    show([
      notification({
        id: 'd1',
        kind: 'digest',
        actor_name: '',
        body: '通知が続いたため、まとめています',
        folded_count: 12,
      }),
    ])

    expect(screen.getByText('ほかに 12 件')).toBeInTheDocument()
    expect(screen.getByText('通知が続いたため、まとめています')).toBeInTheDocument()
  })

  /*
   * digest は actor_name を空で作る（溢れた 1 件目を送った人の名前が残ると、
   * そのあと別の人ぶんを足していったときに嘘になるため）。
   * 画面側がそれを「誰か」で埋めてしまうと、まとめが 1 人からの連投に見える。
   */
  it('まとめの行を「誰か」からの通知にしない', () => {
    show([
      notification({ id: 'd1', kind: 'digest', actor_name: '', folded_count: 3 }),
    ])
    expect(screen.queryByText('誰か')).not.toBeInTheDocument()
  })

  it('差出人の分からないふつうの通知は「誰か」で出す', () => {
    show([notification({ actor_name: '' })])
    expect(screen.getByText('誰か')).toBeInTheDocument()
  })

  it('まとめもふつうの通知も、同じ一覧に並ぶ', () => {
    show([
      notification({ id: 'd1', kind: 'digest', actor_name: '', folded_count: 5 }),
      notification({ id: 'n1', actor_name: 'けいこ' }),
    ])
    expect(screen.getByText('ほかに 5 件')).toBeInTheDocument()
    expect(screen.getByText('けいこ')).toBeInTheDocument()
  })
})
