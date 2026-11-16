import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfigProvider, Layout, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ThemeProvider, useColorTheme } from './theme'
import { DeviceLoginComplete } from './DeviceLoginComplete'
import { LoginPanel } from './LoginPanel'
import { DevicesPage } from './DevicesPage'
import { HomePage } from './HomePage'
import { api, RequestError, type Account } from './api'
import 'antd/dist/reset.css'
import './upstream.css'
import './selfhost.css'
import './brand.css'

export function navigate(path: string) {
  if (window.location.pathname !== path) window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function App() {
  const { colorTheme } = useColorTheme()
  const dark = colorTheme === 'dark'
  const [account, setAccount] = useState<Account | null>()
  const [error, setError] = useState<string>()
  const [location, setLocation] = useState(() => window.location.href)
  const deviceLogin = new URLSearchParams(new URL(location).hash.slice(1)).get('device_login')
  const [path, setPath] = useState(() => window.location.pathname)
  // Keep route state and URL in sync without dispatching popstate: dispatching synchronously makes
  // React commit the route change separately, so an auth transition can render an intermediate
  // unauthenticated route and the guard below bounces /app/remote back to /app/login.
  const justLoggedIn = useRef(false)
  const go = useCallback((next: string) => {
    if (window.location.pathname !== next) window.history.pushState({}, '', next)
    setPath(next)
    setLocation(window.location.href)
  }, [])
  const signedOut = useCallback(() => { setAccount(null); go('/') }, [go])
  useEffect(() => {
    const onPopState = () => { setPath(window.location.pathname); setLocation(window.location.href) }
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onPopState)
    return () => { window.removeEventListener('popstate', onPopState); window.removeEventListener('hashchange', onPopState) }
  }, [])
  useEffect(() => {
    api<Account>('/auth/me').then(setAccount).catch(err => {
      if (!(err instanceof RequestError && err.status === 401)) setError(err instanceof Error ? err.message : '无法连接服务。')
      setAccount(null)
    })
  }, [])
  // These Ant Design tokens are retained from the upstream App.tsx ConfigProvider.
  useEffect(() => {
    if (justLoggedIn.current) { justLoggedIn.current = false; return }
    if (account === null && path === '/app/remote') go('/app/login')
  }, [account, path, go])
  const login = useCallback((next: Account) => { justLoggedIn.current = true; setAccount(next); if (!deviceLogin) go('/app/remote') }, [go, deviceLogin])
  const content = account === undefined
    ? <div className="route-loading auth-route-loading" role="status">正在检查登录状态…</div>
    : deviceLogin && account
      ? <DeviceLoginComplete browserToken={deviceLogin} />
    : path === '/app/remote' && account
      ? <DevicesPage account={account.account} onSignedOut={signedOut} />
      : path === '/app/login'
        ? <LoginPanel onAuthSuccess={login} initialError={error} />
        : <HomePage />
  return <ConfigProvider locale={zhCN} theme={{
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#9db6ef' : '#345b91', colorInfo: dark ? '#9db6ef' : '#345b91', colorPrimaryHover: dark ? '#b6ccf5' : '#284972', colorTextLightSolid: dark ? '#0a0a0a' : '#ffffff', colorSuccess: dark ? '#49aa68' : '#16a34a', colorWarning: dark ? '#d89614' : '#d97706', colorError: dark ? '#ff7875' : '#cf222e',
      colorBgLayout: dark ? '#0a0a0a' : '#f7f8fa', colorBgContainer: dark ? '#141414' : '#ffffff', colorBgElevated: dark ? '#1b1b1b' : '#ffffff', colorText: dark ? '#fafafa' : '#1d1d1f', colorTextSecondary: dark ? '#adadad' : '#6e6e73', colorTextPlaceholder: dark ? '#8d94a3' : '#6e6e73', colorBorder: dark ? '#333333' : '#d9e2ec', colorBorderSecondary: dark ? '#242424' : '#e8e8ed', borderRadius: 10, borderRadiusLG: 16, controlHeight: 40, fontSize: 15, wireframe: false,
    }, components: { Button: { primaryShadow: 'none' }, Table: { headerBg: dark ? '#1b1b1b' : '#f7f7f8', headerColor: dark ? '#c8cdd6' : '#4b5563' } },
  }}><Layout className={account && path === '/app/remote' ? 'app-shell product-shell' : 'app-shell auth-shell'}>
    {content}
  </Layout></ConfigProvider>
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><App /></ThemeProvider>)
