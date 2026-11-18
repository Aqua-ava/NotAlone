# SQLite 讨论的官方 DSH 适配依据

回复行为和输入预算由[现行回复规格](../../../../architecture/current/reply-generation.md)及[Skill 规格](../../../../architecture/current/skill-library.md)维护；本页保存官方扩展接口的核对依据和资源释放细节。版本日期表示查证时点，依赖变化后须重新核对。

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

正式执行只通过 `createAgent`／`resumeAgent` 建立或恢复官方会话；退役仅测试使用的直接会话创建入口。业务副本资格核验集中在 `SqliteDiscussionRuntime.run` 的独占所有者内，不再提供另一条独立打开、核验与关闭副本的公开 `inspect` 流程；回看继续只读 SQLite。具名 `runtime.inspect` 短事务仍服务执行中的资格复验。

`close()` 先拒绝新操作，等待已进入的创建／读档工作，再等待所有官方 AgentHandle 和持久 handle，最后逆序等待每个 Loader fiber 并移除 Group。失败不转换为成功。宿主须保留自己的活动 holder，等待该 Promise 真正结算，不能在超时后清文件。

根目录在进入每个操作及收紧权限前核对 dev/ino/birthtime/uid。官方创建的 `session.lock` 实测可能为 0644；所有者排空后，仅遍历本副本，以不跟随链接的文件描述符复核并收紧目录到 0700、普通单链接文件到 0600，不改变全局 umask，不操作 Skill 原目录。释放或身份复核失败不提供成功关闭证明。完整受管文件清单及删除在讨论领域和统一删除流程执行。

## 验证入口

`node --test test/sqlite-discussion-dsh.test.mjs` 使用官方 Loader、Session、JSONL、AgentLoop 与临时受管目录，数据均为合成。用例覆盖非空事件重开、Agent create/dispose/resume、close 期间末写、根目录身份替换和 scope finalizer 故障；不连接微信或调用真实模型，也不能替代实际 App 验收。

## 有界回复与 Skill 工具

`runSingleDiscussionTurn` 独占按需创建与最终释放的 Skill 运行，不接收预建运行或修改调用参数；回退摘要必须根据真实无 Skill 修订计算。它复用宿主的请求、调用身份、截止时间和输入预算；每次物理发送重新核验冻结依赖并保存实际输入及用量。物理调用数、资源数与多包选择的统一上限见现行回复／Skill 规格，不在适配层建立另一套预算。没有可用 Skill 时不提供 Skill 相关工具；候选资料工具仍按本轮冻结范围和原预算开放。

直接依赖、锁文件及实际安装的 `dsh-tool-skill`、`dsh-working-directory`、`dsh-fs` 均为 `0.2.1-rc.2`。固定官方源码仍为上文 commit，所用合同与安装制品逐项核对；未作全量可复现制品比对：

2026-11-04 按需加载接线沿用上述版本及固定源码：`dsh-runtime.ts` 已挂载官方 `dsh-tool-skill`，不新增插件。正常候选保留官方 `skill` 工具可见，由插件在首次模型调用前发布名称与简介；本轮 provider 在模型选中包时才返回其固定修订正文。候选入口不再调用全部正文预加载，新请求不接收显式选包参数。此处记录接口与接线依据，实际验证结果以本次执行的回归和 App 验收为准。

- [tool-skill 的公开 inject/apply、模型工具及会话目录](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/src/index.ts#L24)，安装 `lib/index.js:762,784`。工具经 `ctx.skills.list/get`、`scope=exec.agent` 读取本轮 provider；其官方目录与工具可见性一致。provider 在 `setup` 中绑定独占 Agent scope，目录不包含未启用 Skill 或能力声明。
- [working-directory 的 ensure](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/working-directory/src/index.ts#L133) 仅需 `fs.resolve/stat` 验证目录；业务 `SkillDirectory extends FileSystem` 只提供 `/notalone` 纯虚拟目录，所有文件读取、枚举、写入与监听均拒绝，不接触宿主目录。复用官方 working-directory 插件，不启用本地 fs provider 或目录扫描插件。
- [FileSystem 的公开实现合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs/src/index.ts#L87)。`createDshRuntime` 通过官方 Loader Group 隔离 fs、Skill registry、working-directory、tools、session 等服务；逐项挂载、排空和卸载，不修改 DSH 核心。
- `dsh-tools/lib/types/index.d.ts:640-656` 与安装 `lib/index.js:2991-3019`：`restrict` 仅限制全局工具，作用域内注册仍可见；因此本轮仅保留全局 `skill`，按需注册 scoped `skill_resource` 并加单调 `guard`。不存在 Shell、通用文件、网络或外部消息发送工具。`tools/pre-execute/post-execute` 复验业务资格并检查真实读取结果；附加资源目录按准确 Skill 名称关联允许的相对路径与大小；不同 Skill 中同名路径不得串读。

2026-11-17 实现收敛：按 ADR-193 统一目录按需加载，退役批量及显式单包正文预加载入口、手工 `registry.snapshot/get` 预加载分支及定向 provider 状态；历史预加载输入和回执仍按原来源及删除合同读取。版本与公开 provider 接口再次核验见 [Skill 模块说明](../../skills/sqlite/README.md#当前版本依据)。

每个包的选择尝试由实际工具调用和对应 `skill_selection` 区分；`skill_input` 逐项记录真实返回的正文或资源及包修订，简介目录不冒充正文输入。候选区不展示 Skill 清单或正文，后台继续保留实际输入追溯。新 HTTP、IPC 及业务受理明确拒绝旧显式选包字段（含 `null`）；运行期只使用官方 `skill` 工具按需载入，历史版本回看仍保留原实际输入。含 Skill 的本轮总是从合法业务资料建立新运行副本，避免另一轮已加载正文混入当前策略。

任一 Skill 纯读取故障后先停止并排空旧 Agent，登记未提交副本的持久清理意图，逐项核对 `ManagedAddress` 后擦除，恢复时继续该意图。旧运行副本完全清除后，正式事务重新核验所有非 Skill 输入并建立无 Skill 新 context，清除本轮所有 Skill 目录、正文和工具请求载荷，避免部分 Skill 内容残留；只保留无正文调用回执及不可用标记。新副本的配置摘要按新 revision 计算，可正常回看/恢复；联系人资料、授权或来源失效时不降级。

回归入口：`sqlite-discussion-generation.test.mjs` 覆盖 DSH／HTTP／SSE 路径，部分业务端口为替身；`sqlite-reply-skill-loop.test.mjs` 组合 SQLite、联系人、历史、回复入口和运行副本，供应商为环回合成替身。实际 App 和真实模型质量另行验证，旧任务结果不作为当前通过证明。
