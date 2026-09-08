import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { IdentityProvider } from './lib/identity'
import { ThemeProvider } from './lib/theme'
import { installErrorReporting } from './lib/errorReport'
import { loadOutbox } from './lib/outboxStore'
import './index.css'

// 描画より前に仕掛ける（起動中のエラーも拾えるように）
installErrorReporting()

/*
 * オフラインのあいだにためた書き込みを読み込み始める。
 *
 * ボードは読み込みが済むまで描き始めない（RoomPage の読み込みゲート）。
 * 先に描いてしまうと、最初の refetch が「サーバーが知らない行」として
 * ためてあった行を消し、少し経ってから戻ってくる——書いた人からは
 * 一度消えたように見える。
 */
void loadOutbox()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <IdentityProvider>
          <App />
        </IdentityProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
