# xcodex Remote 网页品牌

2026-11-13：按用户要求恢复此前 AgentPort 的 A 标识，站点统一使用 xcodex Remote，不再显示 DeepSeek Harness Remote / DSH Remote 品牌。

- 图标来源：旧项目 `happy/packages/happy-app/public/agentport-icon.svg`，原样复用，保存到 `apps/server/web/public/xcodex-mark.svg`。用于导航、登录页、设备页及 favicon。
- 配色参考 xcodex 官网 `Xcoder/app/globals.css`：深色背景 #0a0a0a、卡片 #141414、浅蓝强调色 #9db6ef；浅色主题采用灰白背景和深蓝强调色。保留主题切换。
- 首页、登录页、设备页、网页标题/描述和页脚统一名称；官网/指南链接指向 xcodex。移除误导为本站更新日志/下载入口的上游链接。
- 保留实际安装命令 `dsh plugin --profile web add ds-harness-remote@0.6.3`，不因品牌更换而虚构 npm 包名。
- 业务样式集中在 `apps/server/web/src/brand.css`，位于 upstream.css/selfhost.css 之后；Ant Design token 同步调整。上游来源与许可文件保留，不把视觉换牌当成源码原创声明。
- Server 为新增 SVG 图标配置正确的 image/svg+xml 响应；不改登录、设备归属、数据库、DNS、证书或共享 Nginx。

验证：Server 类型检查与构建；Chromium 手机390px/桌面1280px、深浅主题的首页/登录页布局、图标加载及品牌文案检查；模拟上游验证码/密码/Google跨站回跳与设备页通过。部署版本见 deployment-agent-xcodex-vip.md。

已上线构建：`xcodex-brand-20261113-c84a5b59fb6f`。公网首页/登录页在两种宽度和两种主题下复验通过。
