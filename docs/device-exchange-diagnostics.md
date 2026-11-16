# 设备凭据兑换：精确契约与安全诊断

2026-11-13。目的：定位客户端 exchange 400；不放宽、不改变现有验证规则。

## 请求契约

`POST https://agent.xcodex.vip/api/v1/auth/device/exchange`

`Content-Type: application/json`；JSON body 最大 16384 字节。

真实校验 schema（`apps/server/src/device-login.ts`）：

```ts
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const deviceExchangeSchema = z.object({
  requestId: proof,
  pickupToken: proof,
  code: proof,
  codeVerifier: proof,
}).strict()
```

四个字段必填、类型 string、恰好 43 个 ASCII 字符，只接受 A–Z、a–z、0–9、下划线和连字符。没有 base64 `=` padding；不能有空格、加号、斜杠，不做 trim 或类型转换，不接受 null。严格拒绝额外字段。

- `requestId`、`pickupToken`：使用 `/auth/device/start` 返回的原始字段。
- `code`：使用 `/auth/device/poll` 返回 `status: ready` 后的 code，不能使用邮箱验证码、Google code 或 token 替代。
- `codeVerifier`：使用本次 start 前保存在客户端的原始 verifier。当前实现为 32 随机字节的无 padding base64url，共 43 字符。`codeChallenge = BASE64URL_NO_PADDING(SHA256(UTF8(codeVerifier)))`。
- `state`：由客户端检查 poll/callback 的值是否匹配发起时的 state；不放进 exchange body。`device`、`redirectUri` 也不在 exchange body 内。
- 通过形状校验后继续验证一次性流程、code、PKCE、过期、用户状态、设备归属；全部保持原逻辑。

## 400 安全诊断

校验失败仍返回 HTTP 400 / `error.code: INVALID_MESSAGE`，新增 `error.details.failures`。每条只包含：

- `field`：固定协议字段名或常见误传字段名；其他任意字段名显示 `<unrecognized-field>`，防止凭据被放进对象 key 后出现在日志。
- `actualType`：`missing` / `null` / `string` / `number` / `boolean` / `array` / `object`。
- `length`：只对字符串和数组给出长度；不会记录字符串内容、数组元素或嵌套对象。
- `reason`：`required`、`invalid_type`、`invalid_length`、`invalid_characters`、`unrecognized_field`。

最多 16 条；不是 JSON 对象时 field 为 `$body`。非法 JSON 在解析前失败，不会有字段明细。Content-Type 错误为 415，body 超限为 413。

**以下仅为人工合成测试，不是用户那次请求：**

```json
{
  "error": {
    "code": "INVALID_MESSAGE",
    "message": "INVALID_MESSAGE",
    "requestId": "server-generated-diagnostic-id",
    "retryable": false,
    "details": {
      "failures": [
        { "field": "codeVerifier", "actualType": "string", "length": 64, "reason": "invalid_length" }
      ]
    }
  }
}
```

服务端 WARN 事件 `device_exchange_rejected` 使用相同 error.requestId，记录 errorCode/httpStatus/stage/failures。这里的 error.requestId 是新生成的诊断关联 ID，不是请求中的设备登录 requestId；不能混用。无请求原文、验证码、token、verifier、Cookie/Authorization 或上游错误原文。

以前的 access log 只留 HTTP 状态，因此 16:45:55、16:53:48、16:54:30（北京时间）三次历史 400 没有字段明细，不能事后推断或将合成探测当真实失败。诊断上线后客户端重新发起完整登录，将 error.code、error.requestId 和 details.failures 提供回来即可。不要发送请求 body 或凭据。

## 验证与发布

- Server 类型检查、103 tests / 7 文件与构建通过。
- 测试覆盖固定长度/字符/类型/必填/额外字段、与原 schema 的拒绝结果一致、无值输出、嵌套对象与恶意字段名隐藏、日志与响应关联 ID 一致。
- 发布前隔离验证与回滚；仅更新 Remote 服务，保持共享 Nginx/DNS/证书与现有数据。发布结果另记。


发布完成：`exchange-diagnostics-20261113-4492148c416b`。仅 Remote 服务重启 0.546 秒，保留 7 个已有设备及账号/凭据。人工构造 64 字符 verifier 请求验证 HTTP 400 / INVALID_MESSAGE、`codeVerifier/string/64/invalid_length`；响应关联 ID 与服务端安全日志一致。这是合成探测，**不是历史用户请求的原因**。尚未收到诊断上线后的真实客户端重试。
