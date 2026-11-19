# Xcodex Remote 0.7.0-xcodex.3

修复外部会话的归档与模型摘要命名，分支 `feat/orca-agent-management`。不修改生产服务、DNS、Nginx 或证书。

## 行为

- 原生 `workspace/archiveSession` / `workspace/unarchiveSession` 接到插件会话存储；归档是可恢复隐藏，不永久删除历史。原生和插件归档列表在响应、工作区快照及增量订阅中合并。
- 正在执行的会话先返回原生 `workspace/session-active` 及活动信息，仅明确 `stopActivity: true` 才取消目标任务并归档。账号、Host、工作区归属检查不变。
- 首次接受消息后，使用对应 Agent 的当前模型（未选定时沿用本机 Agent 默认配置）独立生成摘要标题。Claude 禁用工具/MCP/钩子且不保存命名会话；Codex 使用 Orca 的临时只读后台命令模式。该请求不插入正常对话，不导入命名会话。
- 命名输入最多 8000 字符、进程输出最多 128 KiB、超时 45 秒；每条会话只尝试一次，不自动重试未知结果。失败保留首条消息标题。手动命名优先，退出账号后晚到结果不写入标题，Host 关闭会终止命名任务。
- 归档状态保存在现有 v1 操作记录中，旧快照可直接读取，未新增旧版不能解析的存储字段；退回旧插件会失去归档展示能力，但不会因新字段无法加载数据。

## 验证

Linux / Node.js 24.9.0：插件全量 85 文件、710 项测试通过；最终归档存储兼容调整后重新运行 Backend/Gateway/Store/Title 46 项测试和类型检查。完整 TypeScript 编译、bundle 构建、包结构校验通过；tgz 包外解压后使用已安装 DSH 0.2.2 的共享 connection peer 成功导入 Host 入口。未把裸解压等同完整插件安装或原生 UI 验收。

真实 Claude 独立命名返回“排查登录接口401并修复凭证刷新”。真实 Codex 命名在当前服务器既有环境中启动失败，保留 fallback；不能声称 Codex 实际摘要命名已通过。无本轮 DSH 原生页面、手机/平板或 macOS/Windows 真机验收。完整 Orca 管理子系统迁移仍未完成。

## 安装

GitHub Release 的 `.tgz` 安装方式与上版一致。尚未发布 npm registry，URL 安装不能使用 DSH 的 registry 更新按钮；更新时等待任务结束后安装新包。远程服务无需重启。

SHA-256: 52cba3e734981b94fb4f8b7853bfe1f42fa20fea9199a9137b68d355a5d9a271
