# 日常开发热更新

用户已明确要求：日常使用 `npm run dev` 修改后直接查看效果，避免反复打包。

## 范围

- 一个命令启动 Vite 与真实 Electron；React/CSS 保存后更新。
- main、preload、共享 TypeScript 与 Python 源码变化后，通过现有认证退出流程串行重启；停止未确认时不得强杀或启动第二份。
- 窗口始终保留 `notalone://app` 与既有 IPC 来源校验；开发资源只经受控本机代理提供，正式包忽略开发配置。
- 沿用现有本机配置与资料，不自动迁移数据库。使用 Conda `NotAlone`；开发后端从当前仓库加载。
- 日常开发默认使用此入口；打包仅用于交付及原生签名、权限和随包运行时验证。

## 验证接缝

1. 资源协议：开发代理、来源限制、CSP 与生产隔离。
2. 开发命令：真实 Vite 转换和文件变化；合成自有进程验证串行重启与安全退出。
3. 真实 Electron 和 Computer Use：界面变化直接可见，重启及收尾。合成检查不替代实际桌面结果。

不修改产品业务、同步授权、模型接收方或外部发送能力。

## 实机验证（2026-10-17）

- 真实开发 App 的 React 文案保存后立即更新，仍保留手动选择的“历史导入”页面；CSS 临时描边即时可见，两项临时改动均已还原。
- main 与 preload 变化先完成原进程正常退出，再取得新进程的就绪回执；触发 Python 文件观察后同样正常重启。空配置轮次未启动业务后端，因此此项证明开发监听与 App 生命周期，不代替带业务后端的完整验收。
- 两个窗口都经 Computer Use 打开，地址仍为 `notalone://app`。对开发宿主发送终端中断后返回 0，自有 Electron 进程退出。
- 保留失败：首次将隔离目录作为分离参数传给 Chromium，参数未生效，仅完成默认配置的只读机器诊断；现改为 `--user-data-dir=...` 并核对空目录实际生效。未读取聊天正文或调用模型。
- 保留失败：SIGTERM 触发窗口关闭但 Main 未退场，未宣称重启通过；确认该轮为空配置、没有后台或资料写入后清理自有失败进程。现改用父子 IPC 请求 `app.quit()`，复验自动重启和终端中断通过。产品开发监督器没有强杀兜底。
- 首轮入口重复 render 曾重置页面；只在首次模块加载创建和 render 根节点后，复验 React Fast Refresh 保留页面状态。
- 独立 Spec 审查发现已有配置指向旧 checkout 时可能继续加载旧 Python；已增加仅开发模式的当前源码目录内存覆盖，并验证解释器、配置文件、旧 `.env` 回退和磁盘设置保留。

## 第三方接口依据

Context7 在本次工具清单中不可用，已对照安装版本与官方文档：Vite 8.3.3 的 [createServer](https://vite.dev/guide/api-javascript)、[server.ws 与文件访问范围](https://vite.dev/config/server-options)、[CSP nonce](https://vite.dev/config/shared-options#html-cspnonce)，React 插件固定 6.1.2；esbuild 0.28.2 的 [context/watch](https://esbuild.github.io/api/#watch)，Electron 44.7.0 的 [app.quit](https://www.electronjs.org/docs/latest/api/app#appquit) 与 [protocol](https://www.electronjs.org/docs/latest/api/protocol)。

## 收尾

- `npm test`：类型检查与 140 项自动检查通过；其中新增开发资源、配置与进程测试 7 项，HTTP 来源隔离另在既有窗口边界测试覆盖。
- `npm run build`：生产前端构建通过，未重新打包 App。
- Standards 与 Spec 独立审查的发现均已修正，最终各 0 项未解决问题。
- 空配置验收目录与自有测试进程已清理；固定 `.dev/` 缓存约 20 MB，日常开发实例保留运行。
- 没有迁移、删除或导入业务资料，没有模型调用、微信操作、消息发送或权限变更。日常实例仍如实显示此前已有数据库待迁移状态。
