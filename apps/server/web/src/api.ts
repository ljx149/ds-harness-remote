export interface Account { account: string }
export interface Device {
  deviceId: string; name: string; role: 'host' | 'client'; platform: string;
  clientVersion: string; harnessVersion?: string; online: boolean; lastSeenAt?: number;
}
export interface DeviceList { items: Device[]; serverUrl: string; transport: string }
export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    })
  } catch { throw new RequestError('连接失败，请重试。', 0) }
  const data = await response.json()
  if (!response.ok) {
    throw new RequestError(authMessage(data.error?.code), response.status)
  }
  return data as T
}

export function authMessage(code: string): string {
  const messages: Record<string, string> = {
    AUTH_INVALID: '登录信息无效，请检查密码或验证码后重试。',
    ACCOUNT_AUTH_REQUIRED: '登录已过期，请重新登录。', REAUTH_REQUIRED: '登录已过期，请重新登录。',
    RATE_LIMITED: '请求频繁，请稍后重试。', ACCOUNT_DISABLED: '账号已停用，请联系 xcodex 支持。',
    EMAIL_NOT_VERIFIED: '请先完成邮箱验证。', AUTH_ACCESS_DENIED: '当前账号暂时无法使用服务。',
    ACCOUNT_IDENTITY_CONFLICT: '账号身份校验失败，请联系支持。',
    AUTH_SERVICE_UNAVAILABLE: '登录服务暂时不可用，请稍后重试。',
    AUTH_FLOW_EXPIRED: '登录请求已过期或不是从当前浏览器发起，请重新点击登录。',
    AUTH_CANCELLED: '登录未完成，请重新尝试。', INVALID_MESSAGE: '请检查填写的信息。',
  }
  return messages[code] ?? '请求失败，请稍后重试。'
}
