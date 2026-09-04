import { Navigate, Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import RoomPage from './pages/RoomPage'
import NameGate from './components/NameGate'
import { useIdentity } from './lib/identity'

export default function App() {
  const { displayName } = useIdentity()

  // 表示名が未設定のうちは、まず名前を聞く（これが唯一の「ログイン」）
  if (!displayName) return <NameGate />

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/r/:slug" element={<RoomPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
