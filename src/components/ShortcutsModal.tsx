import Modal from './Modal'
import { formatShortcut, shortcutGroups } from '../lib/shortcuts'

// 一覧は src/lib/shortcuts.ts から作る。ここに手で書くと、実装と食い違っても
// 誰も気づけない（以前は「長押しでレーザーポインター」という実装の無い行があった）
const GROUPS = shortcutGroups()

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="キーボードショートカット" onClose={onClose}>
      <div className="space-y-5">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">{group.title}</h3>
            <dl className="space-y-1">
              {group.items.map(([keys, label]) => (
                <div key={`${keys} ${label}`} className="flex items-baseline gap-3">
                  <dt className="w-40 shrink-0">
                    <kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                      {formatShortcut(keys)}
                    </kbd>
                  </dt>
                  <dd className="text-sm text-slate-600">{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-400">
        文字を入力しているときは、道具の切り替えショートカットは働きません。
      </p>
    </Modal>
  )
}
