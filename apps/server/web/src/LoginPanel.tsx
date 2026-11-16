// Login methods adapted from xcodex's login page; Remote uses a same-origin BFF
// instead of Next.js/Supabase browser cookies. Upstream tokens stay on the server.
import { Alert, Button, Card, Form, Input, Radio, Typography } from 'antd'
import { GoogleOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'
import { api, authMessage, type Account } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
interface Methods { mode: 'local' | 'supabase'; google: boolean; emailCode: boolean }
export function LoginPanel({ onAuthSuccess, initialError }: { onAuthSuccess: (account: Account) => void; initialError?: string }) {
  const [methods, setMethods] = useState<Methods>()
  const [loading, setLoading] = useState(false)
  const [method, setMethod] = useState<'password' | 'code'>('code')
  const googleStarted = useRef(false)
  const [sent, setSent] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [error, setError] = useState(initialError ?? '')
  const [form] = Form.useForm<{ email: string; password: string; code: string }>()
  useEffect(() => {
    let alive = true
    const reason = new URLSearchParams(window.location.search).get('auth_error')
    if (reason) { setError(authMessage(reason)); const url = new URL(window.location.href); url.searchParams.delete('auth_error'); window.history.replaceState({}, '', url.pathname + url.search + url.hash) }
    void api<Methods>('/auth/methods').then(value => { if (alive) { setMethods(value); if (!value.emailCode) setMethod('password') } }).catch(err => { if (alive) setError(err.message) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!cooldown) return
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])
  async function perform(action: () => Promise<void>) {
    setLoading(true); setError('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : '登录失败，请重试。') }
    finally { setLoading(false) }
  }
  async function sendCode() {
    try { await form.validateFields(['email']) } catch { return }
    await perform(async () => {
      await api('/auth/supabase/otp/send', { email: form.getFieldValue('email').trim() })
      setSent(true); setCooldown(60)
    })
  }
  async function submit(values: { email: string; password?: string; code?: string }) {
    if (!methods) return
    await perform(async () => {
      const path = methods.mode === 'local' ? '/auth/login' : method === 'code' ? '/auth/supabase/otp/verify' : '/auth/supabase/password'
      const result = await api<Account>(path, { email: values.email.trim(), ...(method === 'code' ? { code: values.code?.trim() } : { password: values.password }) })
      form.resetFields(['password', 'code']); onAuthSuccess(result)
    })
  }
  async function google() {
    await perform(async () => {
      const result = await api<{ url: string }>('/auth/supabase/google', { deviceLogin: new URLSearchParams(window.location.hash.slice(1)).get('device_login') ?? undefined })
      window.location.assign(result.url)
    })
  }
  useEffect(() => {
    if (!methods?.google || googleStarted.current || initialError) return
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    if (fragment.get('login_provider') !== 'google') return
    googleStarted.current = true
    fragment.delete('login_provider')
    window.history.replaceState({}, '', window.location.pathname + window.location.search + '#' + fragment.toString())
    void google()
  }, [methods])
  return <><main className="auth-page">
    <div className="auth-language-menu"><ThemeToggle className="auth-theme-toggle" /></div>
    <section className="auth-content">
      <div className="auth-logo-stack"><a className="auth-home-link" href="/" aria-label="返回首页"><img className="auth-brand-icon" src="/xcodex-mark.svg" alt="" width="48" height="48" /><Typography.Title>xcodex Remote</Typography.Title></a></div>
      <Card className="auth-panel">
        <div className="auth-intro"><Typography.Title level={3} className="auth-title">{methods?.mode === 'supabase' ? '使用 xcodex 账号登录' : '登录'}</Typography.Title><Typography.Paragraph type="secondary">{methods?.mode === 'supabase' ? '使用与 xcodex 官网相同的账号，连接你的电脑。' : '登录后查看你的设备。'}</Typography.Paragraph></div>
        {error && <Alert className="selfhost-auth-error" type="error" showIcon message={error} />}
        {methods?.google && <Button icon={<GoogleOutlined />} block size="large" onClick={() => void google()} disabled={loading} style={{ marginBottom: 20 }}>使用 Google 登录</Button>}
        {methods?.emailCode && <Radio.Group value={method} onChange={e => { setMethod(e.target.value); setError(''); form.resetFields(['password', 'code']) }} disabled={loading} optionType="button" buttonStyle="solid" options={[{ label: '邮箱验证码', value: 'code' }, { label: '密码登录', value: 'password' }]} style={{ marginBottom: 20 }} />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} className="auth-form">
          <Form.Item name="email" label={methods?.mode === 'local' ? '账号' : '邮箱'} rules={[{ required: true, whitespace: true, message: '请输入邮箱或账号' }, ...(methods?.mode === 'supabase' ? [{ type: 'email' as const, message: '请输入有效邮箱' }] : []), { max: 254, message: '最多 254 个字符' }]}><Input size="large" autoComplete="username" onChange={() => { setSent(false); form.resetFields(['code']) }} disabled={loading} /></Form.Item>
          {method === 'code' ? <>
            <Button block onClick={() => void sendCode()} disabled={!methods || loading || cooldown > 0} style={{ marginBottom: 16 }}>{cooldown > 0 ? `${cooldown} 秒后可重新发送` : sent ? '重新发送验证码' : '发送验证码'}</Button>
            {sent && <Typography.Paragraph type="secondary">请填写邮件中的验证码。若未收到，请检查垃圾邮件或稍后重试。</Typography.Paragraph>}
            <Form.Item name="code" label="邮箱验证码" rules={[{ required: true, message: '请输入验证码' }, { pattern: /^\d{6,8}$/, message: '请输入邮件中的 6–8 位数字验证码' }]}><Input size="large" inputMode="numeric" autoComplete="one-time-code" maxLength={8} disabled={loading} /></Form.Item>
          </> : <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { max: 1024, message: '密码不能超过 1024 个字符' }]}><Input.Password size="large" autoComplete="current-password" disabled={loading} /></Form.Item>}
          <Form.Item className="auth-submit-item"><Button loading={loading} disabled={!methods} block type="primary" size="large" htmlType="submit">登录</Button></Form.Item>
        </Form>
        {methods?.mode === 'supabase' && <Typography.Paragraph type="secondary">注册账号或找回密码，请前往 <a href="https://xcodex.vip/login" target="_blank" rel="noreferrer">xcodex 官网</a>。</Typography.Paragraph>}
      </Card>
    </section>
  </main><SiteFooter /></>
}
