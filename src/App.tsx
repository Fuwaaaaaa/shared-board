import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import NameGate from './components/NameGate'
import Loading from './components/Loading'
import ErrorBoundary from './components/ErrorBoundary'
import { useIdentity } from './lib/identity'

/*
 * ページごとに分けて読み込む。
 *
 * ホーム画面にホワイトボード一式（レイヤー 8 枚と道具）は要らないのに、
 * 1 本にまとめていたので最初に全部を取りに行っていた。
 */
const HomePage = lazy(() => import('./pages/HomePage'))
const RoomPage = lazy(() => import('./pages/RoomPage'))

export default function App() {
  const { displayName } = useIdentity()

  // 表示名が未設定のうちは、まず名前を聞く（これが唯一の「ログイン」）
  if (!displayName) return <NameGate />

  /*
   * 画面ごとの受け皿。Suspense の内側に置くのは、読み込みの失敗も
   * ここで受けるため。ページが落ちても Provider と Router は生きているので、
   * 読み込み直せば同じ場所へ戻れる。
   */
  return (
    <Suspense fallback={<Loading full />}>
      <ErrorBoundary where="page">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/r/:slug" element={<RoomPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </Suspense>
  )
}
