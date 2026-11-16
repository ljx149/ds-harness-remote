# UI 复用来源

来源：`deepseek-harness-server/web/src`（用户提供的本地 Server 仓库）。

- `upstream.css`：原 `styles.css` 的主题、基础样式、登录页、product header、设备列表及响应式规则，保留原声明和值。
- `theme.tsx`：原文件直接复用；`ThemeToggle.tsx` 仅替换国际化文字。
- `LoginPanel.tsx`：沿用原登录页布局和 Ant Design 账号密码表单。
- `DevicesPage.tsx`：原 `AppHeader` product 布局与 `HostsPage` 的标题、Card、Table、Empty、Tag。
- `main.tsx`：原 `App.tsx` 的 Ant Design 主题配置。
- `selfhost.css`：最小版必要间距及长文字换行。

## 2026-11-13：xcodex 登录适配

`LoginPanel.tsx` 登录方式参考 `/root/Xcoder/app/login/page.tsx`；Google PKCE/邮箱验证码/密码流程参考官网 `app/oauth/[provider]/route.ts`、`app/auth/callback/route.ts` 和 `lib/portal-auth.ts`。本项目不是 Next.js，使用同源 BFF 完成服务端兑换与验证，未复制官网的 Supabase 浏览器 Cookie 实现。原版布局保留，品牌改为 xcodex Remote。接口、回调配置与验收限制见 [账号直连文档](../../../docs/xcodex-account-auth.md)。

2026-11-13：实例品牌统一为 xcodex Remote，旧 AgentPort A 图标与官网配色；可见上游署名链接从产品页脚移除，源码来源和许可保留。见 [品牌说明](../../../docs/branding-xcodex.md)。
