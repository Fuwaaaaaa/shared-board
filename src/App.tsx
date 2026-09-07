import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import NameGate from './components/NameGate'
import Loading from './components/Loading'
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

  return (
    <Suspense fallback={<Loading full />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/r/:slug" element={<RoomPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
