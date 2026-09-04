import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { IdentityProvider } from './lib/identity'
import { ThemeProvider } from './lib/theme'
import { installErrorReporting } from './lib/errorReport'
import './index.css'

// 描画より前に仕掛ける（起動中のエラーも拾えるように）
installErrorReporting()

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
