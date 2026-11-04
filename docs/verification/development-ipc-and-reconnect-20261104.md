# 开发 IPC 断开与遗留握手恢复验证

## 问题与改动

- 监督器先断开、窗口随后打开时，旧实现仍调用没有错误回调的 `process.send`，真实 Node 子进程复现 `ERR_IPC_CHANNEL_CLOSED` 和未处理的 `error`。现在连接失效时跳过发送，发送中的断开由回调处理，并请求现有认证退出流程。
- 旧后台已退出但握手仍在时，桌面此前持续连接旧地址。现在仅在信号 0 探测明确返回 `ESRCH` 时交给现有受控启动器；启动器在互斥内再次检查，负责清理归属可验证的遗留运行资源。存活、权限未知及身份不符的目标沿用原认证与拒绝行为。
- 沿用原 SQLite、资料位置、配置和同步授权；不增加数据出站、联系人范围或消息发送能力。

## 自动验证

本机 Node 为 24.22.1；命令均从 `desktop/` 执行。下列用例只使用合成文件、回环 HTTP 与 Node 子进程，不启动 Electron 或读取微信。

- `node --test --test-isolation=none --test-timeout=7000 --test-name-pattern='开发窗口就绪前 IPC' tests/development.test.mjs`：修复前复现相同关闭通道错误；修复后的完整开发模块用例通过。
- `node --test --test-name-pattern='已退出后台的遗留握手' tests/managed-shutdown.test.mjs`：修复前为 `disconnected`，修复后为 `connected`，并确认正常停服。
- `pnpm run typecheck`：通过。
- `node --test --test-timeout=10000 tests/development.test.mjs`：10 项通过，含真实关闭通道与检查后断开的发送回调，以及正常发送、同步失败、串行重启。
- `node --test --test-timeout=12000 tests/development-policy.test.mjs`：6 项通过。
- `node --test --test-timeout=25000 tests/managed-shutdown.test.mjs tests/backend-shutdown-confirmation.test.mjs`：15 项通过，覆盖原目标停读、身份匹配、恢复入口及遗留握手重连。
- `git diff --check`：通过；临时诊断代码已移除。

## 实际开发 App

先执行 `pnpm run dev:status` 确认没有可复用实例。使用独立 session 的后台 `nohup pnpm run dev`，命令结束后再次检查实际 `--notalone-dev` 宿主与其 Node 监督器均存活。初次阻塞启动的失效开发 socket 经确认无监听者、当前用户所有且类型匹配后移开；没有删除未知锁或业务资料。

Computer Use 检查管理后台，先观察到连接失败；修复遗留握手后，源码监督器串行完成正常停读、重启和重连，界面显示“本机服务已连接”，未出现 JavaScript 错误弹窗。最终保留当前热更新实例运行。

IPC 断开的故障注入使用上述真实 Node 合成子进程；没有故意中断承载真实资料的 Electron 进程。本轮不认证微信同步、真实模型生成或完整业务闭环。开发资源占用前后均约为 `.dev` 3.8 MiB、`dist` 3.8 MiB、桌面产物 2.2 MiB、原生缓存 247 MiB，保留当前运行所需资源。

## 接口依据

[Node 24 的连接状态合同](https://nodejs.org/docs/latest-v24.x/api/process.html#processconnected)及[官方发送回调说明](https://github.com/nodejs/node/blob/main/doc/api/child_process.md#subprocesssendmessage-sendhandle-options-callback)。本次未改变 DSH 调用或 profile；实际安装的 DSH 为锁定的 `0.2.1-rc.2`，复用 `backend-ts/src/launch.ts` 中现有的互斥、旧握手核验和运行目录回收逻辑。
