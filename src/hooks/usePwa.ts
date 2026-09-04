import { useCallback, useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * ホーム画面へのインストールと、オフライン検知。
 *
 * Service Worker はプッシュ通知と共用（public/sw.js）。
 * ここではアプリ起動時に登録しておき、オフラインでも枠が出るようにする。
 */
export function usePwa() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(
    () => window.matchMedia?.('(display-mode: standalone)').matches ?? false,
  )
  const [offline, setOffline] = useState(() => !navigator.onLine)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    // 本番ビルドでのみ登録する（開発中はキャッシュが邪魔になるため）
    if (import.meta.env.DEV) return
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 登録できなくても通常利用には影響しない */
    })
  }, [])

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setInstallPrompt(null)
    }
    const onOnline = () => setOffline(false)
    const onOffline = () => setOffline(true)

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const install = useCallback(async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }, [installPrompt])

  return { canInstall: Boolean(installPrompt) && !installed, installed, offline, install }
}
