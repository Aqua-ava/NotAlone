# AI 服务自填配置验收（2026-11-02）

本次按用户要求，在设置页同时提供可编辑的 Base URL 与 API Key，并移除“清空密钥输入”按钮。当前模型仍为 `deepseek-flash`，仅支持现有 DeepSeek Messages 和 Beta strict 协议。设计决策见 [ADR-146](../../architecture/adr/146-editable-deepseek-endpoint.md)。

## 接口查证

锁定、安装的 `@deepseek-ai/dsh-llm-deepseek` 均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。核对已安装包的 `lib/index.js`：`PUBLIC_BASE_URL`（345 行）、`resolveAdapterOptions`（400–435 行）、`messagesApiRoot`（566–568 行）和请求的 `redirect: 'error'`。类型入口及相邻 DSH 源码固定提交 `687f282e8625c6b8d11ff58211a90524be2e4317` 已核对；未使用相邻目录不同 HEAD 代替安装版本，也未修改 DSH 或依赖。

## 自动检查

以下命令均在相应工作目录运行并通过；模型传输使用合成服务或拦截 fetch，不访问真实供应商。

| 工作目录 | 命令 | 结果 |
| --- | --- | --- |
| `backend-ts` | `node --test test/sqlite-setup-model.test.mjs` | 5/5；认证接口、原子保存、0600 权限、参数拒绝、环境覆盖及无调用 |
| `backend-ts` | `node --test test/host-reply-config.test.mjs test/model-output-configuration.test.mjs test/model-provider.test.mjs` | 11/11；官方兼容、自定义接收方、认证绑定、同接收方 strict 路由及未知模型拒绝 |
| `backend-ts` | `node --test test/sqlite-memory-profile.test.mjs test/sqlite-reply-candidates-profile.test.mjs` | 3/3；正式 profile 的记忆及回复流程回归 |
| `desktop` | `node --test tests/setup-configuration.test.mjs tests/setup-view.test.mjs` | 12/12；控制器、IPC、preload 与实际 React 表单 |
| `desktop` | `node --test tests/setup-view.test.mjs` | 移除按钮后复验 2/2 |
| 两端 | `pnpm run typecheck` | 通过 |
| `desktop` | `pnpm run test:inventory` | 通过 |
| 仓库根目录 | `git diff --check` | 通过 |

新增行为先观察失败再实现。另行检查普通与 strict 请求均禁止重定向，替换地址不会回落到官方接收方；原有来源、授权及预算规则保留。

## 实际桌面操作

通过 Computer Use 操作 `pnpm run dev` 启动的真实 Electron 开发应用，使用独立用户目录、合成联系人和未开启读取的测试数据库，未打包。初始配置为空，填入回环测试地址及合成密钥后保存；应用完成受控停读和重启，地址正确回读，密钥输入为空，保存按钮禁用。仅核对测试配置是否匹配，不输出密钥；配置文件权限为 0600。

再次输入合成密钥后修改地址，密钥立即清空，未保存该次修改。移除按钮后检查热更新画面，AI 服务只保留两个输入框和保存按钮，布局正常。测试数据库 `model_call` 总数为 0，未调用模型或发送外部消息。未改写用户原有凭据和服务配置。

验收后正常退出隔离应用，`dev:status` 确认为 stopped，核对无进程引用后移除自建临时目录，占用从 17,651,912 字节降为 0。共享开发构建继续复用，未新增 App 或运行时副本；恢复原用户目录的开发应用，`dev:status` 为 development，实际设置页显示本机服务已连接，原官方地址仍在、密钥输入为空且没有清空按钮。

## 验证范围

已验证保存、重启、回读及自定义路由合同。没有向第三方真实服务发送数据，不能据此保证任意网关兼容或其模型容量符合声明。本次不涉及微信同步或消息发送验收；没有将保存成功当作模型连通或效果验证。
