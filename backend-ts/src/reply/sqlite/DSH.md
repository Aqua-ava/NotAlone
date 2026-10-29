# SQLite 讨论的官方 DSH 适配依据

本模块由正常 DSH profile 启动后的业务插件提供 `Context`，不创建另一套 Harness。`createDshRuntime` 只接受受信任宿主已排他创建并登记真实身份的私有副本根。业务范围、来源、请求、代次、ready 和统一删除账本由讨论服务管理；本适配层不能独立授予生成或删除资格。

## 锁定接口

2026-10-29 核对 `backend-ts/package.json`、`pnpm-lock.yaml` 与实际安装制品：DSH/session/agent/agent-loop/persistence/jsonl 均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`；公开 Loader 为 `1.0.6`，新增为直接依赖，未升级底层版本。源码参考提交为 `687f282e8625c6b8d11ff58211a90524be2e4317`；本机相邻源码 HEAD 不同，查证用 `git show` 固定对象，未改源码工作树。未证明 npm 制品与该源码树可复现逐字一致。

- `dsh-agent/lib/types/index.d.ts:42-145`：调用方提供官方 `SessionId`；`AgentRegistry.create/resume` 返回具有 `dispose()` 的所有者。
- `dsh-agent-loop/lib/index.js:1702-1737`，对应[固定源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L544)：释放依次 cancel、whenIdle、scope.dispose、持久 handle.close，再撤下注册；不能把 cancel 当排空。
- `dsh-session-persistence/lib/types/handle.d.ts:37-105`，对应[固定源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence/src/handle.ts)：flush 是耐久屏障；close 不可取消，须排空并释放所有权。
- `dsh-session-persistence-jsonl/lib/index.js:149-176,385-442,3614-3640`：close 可继续 drainLive 末写；provider 保留消费者释放期间的写入路由，根 Context 并发释放没有顺序保证。
- `cordis-plugin-loader/lib/types/config/tree.d.ts` 的公开 `create/resolve/remove`、`config/entry.d.ts` 的 `inject`、`config/isolate.d.ts` 的 `isolate`：每个副本使用独立官方 Group 与服务作用域。AgentLoop entry 显式声明完整依赖，由官方 Loader 将注入传播到后代 scope；业务代码不调用 `internal/plugin`、不修改 `Inject` 或 SDK 核心。
- `cordis/lib/index.js:1372-1383`：Fiber 把部分 effect 释放错误记为 logger.error 后吞掉，单独等待 AgentHandle.dispose 不足以证明所有 scope finalizer 成功。公开 `LoggerService.exporter`（`lib/types/logger.d.ts:23-39,85-103`）只观察本 Group 后代的 error/warn 级别与 fiber 元数据，记录一个失败位；不读取、复制或保存 args。出现该类错误后关闭证明保持失败。

## 边界与资源

`readHistory` 用官方独占 write-open、flush、read、close 取得实际事件。边界保存当前官方格式版本、事件数、末事件 seq 和完整事件序列的 SHA-256；不持久保存进程内 persistence.identity 或 stat.revision。官方 resume 可追加恢复事件；业务在恢复前核对旧边界并置 dirty，完成真实释放后重新取边界，不能要求恢复后的边界永远等于恢复前。

`close()` 先拒绝新操作，等待已进入的创建／读档工作，再等待所有官方 AgentHandle 和持久 handle，最后逆序等待每个 Loader fiber 并移除 Group。失败不转换为成功。宿主须保留自己的活动 holder，等待该 Promise 真正结算，不能在超时后清文件。

根目录在进入每个操作及收紧权限前核对 dev/ino/birthtime/uid。官方创建的 `session.lock` 实测可能为 0644；所有者排空后，仅遍历本副本，以不跟随链接的文件描述符复核并收紧目录到 0700、普通单链接文件到 0600，不改变全局 umask，不操作 Skill 原目录。释放或身份复核失败不提供成功关闭证明。完整受管文件清单及删除在讨论领域和统一删除流程执行。

## 本票验证

`node --test test/sqlite-discussion-dsh.test.mjs` 使用真实官方 Loader、Session、JSONL、AgentLoop 与临时受管目录，全部数据合成；未连接微信、未调用模型。覆盖非空事件重开、真实 Agent create/dispose/resume、close 期间末写、根目录身份替换、真实 scope finalizer 故障。上述测试不是正常产品 profile、真实模型质量或桌面验收的替代。

## 单次讨论执行壳

`generation.ts` 的 `runSingleDiscussionTurn` 接受宿主已准备的请求／调用身份、正常模型配置及 `installModelProvider` 实例，进入 `SqliteDiscussionRuntime.run`。它只允许一个实际模型 stream，禁止 Tool 与自动重试；以显式 SessionId 过滤 `llm/stream`，发送前通过具名 `runtime.inspect` 和 `SkillRunProtection` 复验，在 `beforeDispatch` 等待 `discussion.dispatchCall` 保存实际完整 DSH 请求。此载荷去掉 AbortSignal，不含认证头，不冒充逐字 HTTP 请求实体。

选定 Skill 经真实 `SqliteSkillRun.mount` 及官方 `SkillRegistry.snapshot/get` 加载，必须显式传入 `scopeOf(agentCtx)`；省略 scope 的官方读取只看全局层。没有选定时不把目录或选择事实冒充正文载入。模型结束后等待 `whenIdle/dispose`，从持久日志读取本次新增的非 interrupted `assistant/message`，核对 provider、model 和 text 后才提交 `discussion.commitAssistant`。失败仅走 `discussion.failCall`，可能已授权的尝试不猜测为未发送；许可在真实 SDK 收尾后释放。

`sqlite-discussion-generation.test.mjs` 使用真实官方 DSH、正常业务 ModelProvider、环回 HTTP/SSE 和持久文件；SQLite 讨论动作与 RuntimeManager 通过明确业务端口替身隔离，未声称完成实际 SQLite 讨论接线。Skill 用例另复用真实 SQLite Skill 库、原目录和官方 provider，保护端口为显式合同替身。覆盖正常发言、已完成会话 resume、HTTP 失败不重试、流中取消、发送前及结果返回后来源失效，以及选择／实际载入分开记录。全部资料合成，没有外部模型或微信调用。
