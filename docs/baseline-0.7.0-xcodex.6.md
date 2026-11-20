# 旧版基线对比包 0.7.0-xcodex.6

2026-11-20。用户反馈当前版本仍无流式输出，明确要求回到手机双端适配完成时的插件版本重新发行。

- 分支：`release/baseline-0.7.0-xcodex.5`，起点 `c92b8444`（0.7.0-xcodex.5）。
- 保留旧包名 `xcodex-remote`，只提高到 `0.7.0-xcodex.6`；插件业务源码除版本常量外与起点相同。
- 不包含 40a5448a 起的高级管理、队列、启动配置、进程管理重构，也不混入后来的重启目录、模型目录/分页或流式修复。
- 新包用于用户对比旧版体验；不宣称恢复流式功能或已验证用户电脑的体验。
- 当前 Xagent 开发分支保持不变，服务端、Nginx、DNS、证书和生产服务未修改。

## 安装

在 DSH 停止当前会话任务后，停用当前 `@xcoder/xagent`，再通过插件管理安装本包；两者使用相同插件 ID `vip.xcodex.remote` 与 Cordis 实例 `xcodex-remote`，不要同时启用。保留原登录/配置/会话目录；安装前备份本机插件数据，不选择清除数据。

包名不同，不保证插件管理器会把安装识别为原位更新。此包版本低于 0.8 系列，使用显式包安装。需要恢复时，停用此包并重新安装保留的 0.8.1-xagent.4。

存储 schema 仍为 version 1，与当前版一致；不代表所有新版本事件/启动设置都能被旧版解释。先用新建测试会话比较，不在未核对状态前恢复旧版不认识的待执行任务。

## 验证

使用 Node.js 24.9.0 / Linux。构建依赖复用现有锁定版本（锁文件相比当前仅 workspace 包名别名不同），不更新依赖。所有测试与构建串行经过 `scripts/check-with-budget.py`，内存/CPU 上限取空闲资源三分之一与 2 GiB/单核较小值；结束清理检查组。

插件测试共 87 文件 / 722 项通过：首轮 721 项通过，另一个 Android 依赖测试在补齐新工作树依赖链接后单独复测通过。手机真机、用户 macOS 与真实 Agent 聊天待用户验收。

- 源码/测试类型检查、bundle 构建及校验通过；包含 329 文件，敏感配置文件名检查通过。
- 包外 npm 安装（跳过安装脚本及可选原生依赖），提供精确 rc.5 Host 的 Connection peer 后插件入口 import 通过，CLI --help 通过；不等同原生桌面/真实会话验收。
- Host bundle 与 c92b8444 比较，去除源码路径注释及版本常量后完全一致；Client bundle 无差异。
- 包路径：`/root/xagent-baseline-release/xcodex-remote-0.7.0-xcodex.6.tgz`。
- SHA-256：`5b34410ad7ab8b5a30717900557a2afa22e16d9a3911b3fb95fb73c00973e4cc`。
- 发布地址：https://github.com/ljx149/ds-harness-remote/releases/tag/xcodex-remote-0.7.0-xcodex.6
- GitHub 预览包；未发布 npm。源码提交以发行标签为准。
