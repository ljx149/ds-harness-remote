# Xagent 重启后 CC/Codex 会话不可见：0.8.1-xagent.2

2026-11-20。用户报告最新版插件退出 DSH 再打开后，CC/Codex 会话从侧栏消失。尚未读取用户电脑的日志/会话文件，不能认定其数据已删除，也不能把本机复现视为用户问题已最终验收。

## 已复现的代码缺口

ManagedSessionStore 会将会话、Provider ID、消息和回执落盘。Host 启动时身份及服务端凭据异步恢复；managed catalog 在没有已授权身份时按权限要求返回空列表。原来的 catalog 订阅只在存储更新或主动操作时通知原生 workspace/follow 和事件流。登录恢复不修改会话存储，因此首屏读到空列表之后可能一直不刷新。

## 修复

Backend 有 catalog 订阅者期间，用一个每秒一次的轻量检查观察已认证 ownerId/hostId 变化；不读取消息文件、不发起网络请求。身份从未知恢复、切换或退出时，清空内存归属缓存并触发已有 catalog 通知；workspace/follow 重新合并持久会话，事件流补发会话目录变化。仍按账号、设备、工作区 ID 和路径校验，不通过绕过认证显示历史。

最后一个订阅取消或 Backend 关闭时清理定时器。无需清空本地数据、创建替代会话、重新配对或改服务端。

## 回归证据

新增 managed-agent-restart.test.ts：创建 Claude/Codex 会话，记录 Provider ID 和消息，关闭存储，再重新打开；先在未认证状态建立真实 gateway workspace/follow 订阅，再恢复身份。旧代码等待刷新超时失败；修复后自动收到 replace，原始 ID、消息保留。切换其他账号隐藏会话，切回恢复，退出登录隐藏；订阅关闭不遗留定时器。

这不是用户电脑真机验收，也不保证其他原因（数据目录变化、profile 不同、身份被重建、工作区变化）不存在。若新版仍未恢复，需要只读检查用户的插件版本、profile、登录状态和会话文件元数据，不要求提供凭据或聊天正文。

## 发布与验证

测试版本 0.8.1-xagent.2。只修改插件，不改变线上服务。Linux / Node.js 24.9.0：95 文件、802 项测试通过，源码/测试类型检查、版本同步、构建、DSH 包校验及仓库外 npm 试装、Host 加载通过。试装未运行可选原生依赖安装脚本。

包：`/tmp/xagent-release-0.8.1-xagent.2/xcoder-xagent-0.8.1-xagent.2.tgz`。
SHA-256：`9dad5566dea59bdc19ee6a69f769d73d97050573a4ffb399720b87467fca0018`。
发布到本 fork 的 GitHub 测试 Release；npm 发布仍暂停。
