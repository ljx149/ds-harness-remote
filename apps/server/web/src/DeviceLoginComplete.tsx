import { useEffect, useState } from 'react'
import { Alert, Button, Card, Typography } from 'antd'
import { api } from './api'

export function DeviceLoginComplete({ browserToken }: { browserToken: string }) {
  const [result, setResult] = useState<{ redirectUrl?: string }>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setError(undefined)
    setResult(undefined)
    void api<{ redirectUrl?: string }>('/auth/device/complete', { browserToken }).then(value => {
      if (!active) return
      setResult(value)
      if (value.redirectUrl) window.location.assign(value.redirectUrl)
    }).catch(err => { if (active) setError(err instanceof Error ? err.message : '登录交接失败，请重新尝试。') })
    return () => { active = false }
  }, [browserToken, attempt])
  return <main className="auth-page"><Card style={{ maxWidth: 480, margin: '64px auto', width: 'calc(100% - 32px)' }}>
    <img src="/xcodex-mark.svg" width="48" height="48" alt="xcodex" />
    <Typography.Title level={3}>{result ? '登录完成' : '连接你的设备'}</Typography.Title>
    {error ? <><Alert type="error" message={error} /><Button onClick={() => setAttempt(n => n + 1)}>重试</Button></>
      : <Typography.Paragraph>{result ? '可以返回插件或 App，设备会自动连接。' : '正在完成设备登录…'}</Typography.Paragraph>}
    {result?.redirectUrl && <Button type="primary" href={result.redirectUrl}>返回 App</Button>}
  </Card></main>
}
