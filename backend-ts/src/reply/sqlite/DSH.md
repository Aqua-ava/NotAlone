# SQLite 讨论的官方 DSH 适配依据

本模块由正常 DSH profile 启动后的业务插件提供 `Context`，不创建另一套 Harness。`createDshRuntime` 只接受受信任宿主已排他创建并登记真实身份的私有副本根。业务范围、来源、请求、代次、ready 和统一删除账本由讨论服务管理；本适配层不能独立授予生成或删除资格。

## 锁定接口

2026-10-29 核对 `backend-ts/package.json`、`pnpm-lock.yaml` 与实际安装制品：DSH/session/agent/agent-loop/persistence/jsonl 均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`；公开 Loader 为 `1.0.6`，新增为直接依赖，未升级底层版本。源码参考提交为 `687f282e8625c6b8d11ff58211a90524be2e4317`；本机相邻源码 HEAD 不同，查证用 `git show` 固定对象，未改源码工作树。未证明 npm 制品与该源码树可复现逐字一致。

- `dsh-agent/lib/types/index.d.ts:42-145`：调用方提供官方 `SessionId`；`AgentRegistry.create/resume` 返回具有 `dispose()` 的所有者。
- `dsh-llm/lib/types/types.d.ts:154-172`：`TokenUsage.inputTokens`仅计未缓存输入，与`cacheReadTokens/cacheWriteTokens`互斥；总配额实耗将三者与outputTokens相加，缺少usage保留NULL。`dsh-session/lib/types/types.d.ts:330-338`的真实assistant事件提供该usage。发送前预算取现有provider最终序列化测量，不能用模型配置上界或零值冒充实测。
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

## 有界回复与 Skill 工具（2026-10-31）

`runSingleDiscussionTurn` 保留宿主准备的请求和逻辑调用身份，最多执行 5 次物理模型请求。官方 `skill` 工具最多读取一个正文，业务 `skill_resource` 工具最多读取两份当前正文所列的静态资料；剩余步骤用于最终候选与至多一次无 Skill 继续。模型/工具/继续共用原请求截止时间，供应商适配器不自动重试；每次物理发送都重新核验范围、固定资料、来源、Skill 修订和完整请求预算，逐次保存实际输入及各自用量。没有可用 Skill 时工具表为空。

直接依赖、锁文件及实际安装的 `dsh-tool-skill`、`dsh-working-directory`、`dsh-fs` 均为 `0.2.1-rc.2`。固定官方源码仍为上文 commit，所用合同与安装制品逐项核对；未作全量可复现制品比对：

- [tool-skill 的公开 inject/apply、模型工具及会话目录](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/src/index.ts#L24)，安装 `lib/index.js:762,784`。工具经 `ctx.skills.list/get`、`scope=exec.agent` 读取本轮 provider；其官方目录与工具可见性一致。provider 在 `setup` 中绑定独占 Agent scope，目录不包含未启用 Skill 或能力声明。
- [working-directory 的 ensure](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/working-directory/src/index.ts#L133) 仅需 `fs.resolve/stat` 验证目录；业务 `SkillDirectory extends FileSystem` 只提供 `/notalone` 纯虚拟目录，所有文件读取、枚举、写入与监听均拒绝，不接触宿主目录。复用官方 working-directory 插件，不启用本地 fs provider 或目录扫描插件。
- [FileSystem 的公开实现合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs/src/index.ts#L87)。`createDshRuntime` 通过官方 Loader Group 隔离 fs、Skill registry、working-directory、tools、session 等服务；逐项挂载、排空和卸载，不修改 DSH 核心。
- `dsh-tools/lib/types/index.d.ts:640-656` 与安装 `lib/index.js:2991-3019`：`restrict` 仅限制全局工具，作用域内注册仍可见；因此本轮仅保留全局 `skill`，按需注册 scoped `skill_resource` 并加单调 `guard`。不存在 Shell、通用文件、网络或外部消息发送工具。`tools/pre-execute/post-execute` 复验业务资格并检查真实读取结果；附加资源目录只投影允许的相对路径与大小。

选择尝试由实际工具调用和 `skill_selection` 区分，`skill_input` 只记录真实返回正文或资源。候选名称仅由实际加载的正文投影。显式版本 API 仍经同一 provider 预加载，正常 UI 不要求手选。含 Skill 的本轮总是从合法业务资料建立新运行副本，避免另一轮已加载正文混入当前策略。

Skill 纯读取故障后先停止并排空旧 Agent，登记未提交副本的持久清理意图，逐项核对 `ManagedAddress` 后擦除，恢复时继续该意图。旧运行副本完全清除后，正式事务重新核验所有非 Skill 输入并建立无 Skill 新 context，清旧目录、正文和工具请求载荷；只保留无正文调用回执及不可用标记。新副本的配置摘要按新 revision 计算，可正常回看/恢复；联系人资料、授权或来源失效时不降级。

验证入口：`sqlite-discussion-generation.test.mjs` 使用真实 DSH/HTTP/SSE，部分业务端口为明确替身；`sqlite-reply-skill-loop.test.mjs` 使用真实 SQLite、联系人、历史、回复入口及运行副本，仅供应商为环回合成替身，覆盖自动选择、无 Skill、资源、读取前/部分读取后失效、helper 故障、授权撤销、取消、大资源、清理中断恢复与实际输入/用量。正式 profile 及隔离 `pnpm run dev` 的实际 App 验收另见任务记录；没有真实模型质量或微信渠道声明。
