# DSH 02 独立运行时审计

日期：2026-10-23。只读核验官方源码／公开 npm 制品，不读取 `backend-ts/` 实现，不代替 02 的运行验收。产品仍为 Python。本文件为独立证据，由主会话收录，不修改任务状态、planning 或产品文件。

## 结论与证据强度

- **发布级关联已补齐**：`git ls-remote` 返回官方 `refs/tags/dsh-v0.2.1-rc.2` → `687f282e8625c6b8d11ff58211a90524be2e4317`。01 的候选正是该发布 tag 指向的提交。
- **制品身份已证**：实际下载 CLI 加 12 个关键包，逐个核验 registry SHA-512；CLI 另核验 SHA-1。13 个包的非通配符 exports 目标存在；其运行 dependencies 经源码 workspace 版本转换后全部一致。README 等非编译材料与候选源码一致；未发现相反版本证据。
- **构建字节映射未证**：这 13 个包没有 `gitHead`、registry `dist.attestations`、source map 或发布的 `src/`。发布 tag＋manifest＋相同文档不等于二进制可复现构建证明。本次没有重建官方源码，不声称编译 JS 与该提交逐字节等价。
- **完整安装闭包未证**：没有安装产品或临时完整依赖树；源码 pnpm 锁不等于 npm 消费端锁。02 必须提交自身完整 lock、resolved/integrity、peer/optional/native 依赖结果并实际导入与启动。发布 tag＋完整 integrity 锁＋关键发行接口核对足以固定可复查发行版本；02 未要求逐字节 reproducible build，缺少 gitHead／attestation 本身不是硬阻塞，只有实际制品接口／行为不符才构成方案冲突。此审计不签收 02、不解锁 03。
- **可行路径仍是官方 profile**：空 bundle＋允许清单 patch 可避免引入默认通用能力；七服务内核、provider 和业务薄插件分别装配。不能照搬 `sdk-minimal`，也不能用测试中的直接 `new Context()` 替代产品 profile。
- **新增出站风险**：官方 DeepSeek host 默认产生磁盘匿名 ID 并作为请求头发送，session ID 也会随请求发送。这不是 JSONL 或日志上传，但仍须列入出站／文件范围；关闭三个上传插件不能证明请求只含业务必要字段。后文给出源码位置。

## 发行制品与可复现固定办法

官方来源：[固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)、[CLI 精确 registry 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.2)。所有以下包版本均为 `0.2.1-rc.2`；源码引用以该提交为基准。

CLI tarball 为 `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz`，25,130 bytes，SHA-1 `a502d1551aabc881020e3cb7961c38901565731a`，SHA-512 `tvY+yhfKRifthbqPe/OK0AYxM5ZkvqfYq/jMYgJcEUxiRRL1Vwra3Ti5TB6AXgSWQdiPHYh/Vp6SJa9yHwMNuw==`。其 20 个文件包含 `lib/profile-boot.js` 与声明文件；公开 `./profile-boot` 导出 `prepareProfile`、`runProfile` 等入口，无根 `.` 导出，不能猜测根默认导入。

下表 SHA-512 均实算匹配 registry 的 `sha512-<值>`，仅列本次下载范围，不冒充全依赖清单。

| 包（省略 @deepseek-ai/dsh-） | tarball bytes | SHA-512（Base64） |
| --- | ---: | --- |
| app-boot | 117797 | `kMS4f6AGOPjGsTz3UXWihl5l2Vnm8y9dIayXIF9EafV6F73vgGR+uoBAq4p8qxSq72QfUSGx2yuDP2Hjw4ktlg==` |
| sdk-minimal | 9619 | `mQ+RZyvip6LW3+jA206moCmERo2p0y6DzZGVM8/IfqZWQANrJN9+BpC9KYj8npwaF/tgxtoQYKSC9IRHs3jJbA==` |
| agent-loop | 48508 | `dM0tvxTywkTPtXGCQS/FMhigW37JS4g4ChjQFiaBqrMYet8FDbQbMJb8uFFPPpcRnQufzdq7NqJziYwpsaQBOw==` |
| agent | 46870 | `e96Tnq8g/RNCDDUW7kAypY/4cho5QxjLHMhk86BGGIEu9b31XEkSFqwqQIwtYXQez3cDR5z7LZpAM8Uqx9Y8KA==` |
| session | 98627 | `WDA4lIrXtG5nf1dn2wrA4UzEr7D6e8T3AdPpVSZ7eY4N4ICMDZ0RYuD4GkM+iSb7WkLojdO8ljr0etiIMEbqJg==` |
| tools | 149901 | `K3gET3VPbtxM66pkeRsEGrZ+bQKiBqrTbNXiIreBKu0hP+qPvlSwhiSI5MTnFp2tMFK5rpuYMZosRIdbfrbJ/g==` |
| llm | 115787 | `3xfoMDHEpUJGcH2Lu+lNXUJYRBclYfBkdCG9Au02VzIjYAm9BrFmc/MNuaVTg0vwgvPpTsd6Fx1IeGtfmQFvlg==` |
| llm-deepseek | 66127 | `CxWvAB8FwnTJTZE7b5k0A3sAmC4mq2UJZNSsSNn7lWsquCcPoTvsR37UDo8ec352oBbYzrw+f9+h91oYLfhmqQ==` |
| skill | 21999 | `lB9mB0zG+H6oUSvDllF3QJ5yHIm+QAlCu8/nsWdvQV0APAjBJDrwH/u7A0n9La5T2VbsoGEIjWivmLcJmMFg7w==` |
| tool-skill | 24391 | `QlDOfoOrr1NY9gk1ebOBcmuk9SKHEbX9Qw3Dc17UWlQqWTXGdFce/fAnJAo+6xgpBMqA8PvfXrD6r94wCHmYSQ==` |
| fs-local | 27435 | `IZPJ12/EpV6fu3CCWtW4w4GthXAKLFjplm4Feoep2HAum7J1aGzHZwiw7ipsPCZiA5/TyK3lDUUAGZ/pcXgRcw==` |
| home-paths | 10055 | `+byrn2eS9XaFt6pl1yZXIgkm7GbbzTwzX3Eo19Ew9P1xzzucw/j2HSmdFo221/GK+5PH7ct1ldeT+fAxAJ1e9w==` |

复现本次核验：从 registry 精确版本 URL 保存 JSON，下载其 `dist.tarball`，以 Python `hashlib.sha512`＋Base64 对照 `dist.integrity`；用 `tarfile` 安全解压，读取 package.json，遍历每个非通配符 exports 指向的文件；将候选 manifest 的 `workspace:*` 转成目标包精确版本、`workspace:~` 转成 `~<目标版本>`，对比发行 dependencies。本次仅查 dependency 声明，不把 peer 满足性计作已通过。LICENSE 位于源码仓根而非各包目录，不将包目录缺少 LICENSE 误报为内容版本冲突。

官方发布流程 [release-publish.yml](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/.github/workflows/release-publish.yml#L1-L86) 描述在发布 tag 上 `pnpm install --frozen-lockfile` → `build:official` → `release:pack`，再上传相同 tarball；该 workflow 是设计证据，不是本次发布运行的 attestation。`scripts/release/publish.ts:64-65,197-201` 比较 tarball integrity，防止覆盖不同内容；本次未查得可信构建证明。

源码 `pnpm-lock.yaml` SHA-256 为 `4637cca3b89c4c8d5a147321710e597aa62ec2444a3772ab542be5690893dfe4`。`apps/cli` importer 中 commander 固定解析 15.0.0、js-yaml 4.3.2、node-addon-require-builtin 0.1.9（锁文件 494–502 行），但发行 manifest 仍为 `^15.0.0`、`^4.3.2`、`^0.1.9`；Cordis／Schemastery 为 `~4.0.5`／`~3.18.5`。**直接安装精确 DSH 顶层版本仍可能解析出不同外围依赖**。

02 固定方法：先确定所有直接运行／类型依赖的精确版本，在专用消费项目生成完整 lock，保存每个 registry resolved/integrity、安装工具和 Node 版本；核验 peer 与 optional/native 依赖、审查 install scripts 后再执行需要的安装。复验使用 frozen/ci 模式，不每次重新求解范围。若消费闭包与候选 pnpm 锁不同，明确逐项差异；如需完全对齐，用消费端 overrides 固定经过验证的版本并重跑，不改 DSH 源码。若需要强构建同源证明，应从上述 SHA 及原 pnpm 锁按已审查官方流程重建并比较所有发布文件，或取得可信官方构建 attestation；不能补造 `gitHead`。

部分包 manifest 声明 `./src/*`，但本次 tarball 中均没有 src 文件；声明通配符不证明目标存在。使用明确的公开根／`types`／`profile-boot`，逐项执行真实 import；不能 deep-import 源码内部函数。当前导出文件存在检查也不能证明其传递依赖可解析。

## 官方最小 profile：内部服务与模型工具分别核对

| 层 | 必要或条件依赖 | 裁剪与验证 |
| --- | --- | --- |
| 官方宿主 | `@deepseek-ai/dsh/profile-boot` 的 `runProfile`；app-boot/loader/include、启动环境等由官方入口管理 | 用隔离 DSH_HOME 与固定 application profile，不能跳过官方 profile。profile 支持空 bundles 后加自有 patch；`profile.ts:747-773`。 |
| Agent 内核 | `llm`、`sessions`、`sessionProjections`、`systemPrompt`、`tools`、`agents`、`agent-loop` | 官方 `agent-loop/tests/loop.spec.ts:31-40` 七服务装配；`agent-loop/src/index.ts:342` 硬 inject 六服务。`sessionProjections` 不能漏。 |
| 工具运行 | tools 硬依赖 `systemPrompt`，默认 native | `tools/src/index.ts:809,812,855`。无需 PTC、Shell、sandbox、terminal、jobs、workflow 或 subagent 执行能力。包安装／peer 依赖存在不等于插件激活，更不等于模型获得工具。 |
| 单次语义 | `llm`＋显式 provider | `llm/README.md:47-63,93,176`：一次 stream 是一次 provider attempt；独立于 Agent loop，输入冻结、终态判定与业务校验由调用者承担。 |
| DeepSeek route | `dsh-llm-deepseek-api-key` 硬 inject 只有 llm | `llm-deepseek-api-key/src/index.ts:13`；`dsh-llm-deepseek` 本身导出 transport 类和 host helper，不应误当独立自动注册 provider 的插件。注册路线为 `deepseek-official`。 |
| Skill | 业务需要时增加 skill registry＋受控 provider／tool-skill | 不启用任意 filesystem Skill provider；目录、版本、至多一个 Skill、失效与业务身份由业务限制。`tool-skill` 声明 working-directory peer 不等于允许通用文件工具；按实际启用路径验证服务需要。 |
| 模型可见工具 | 当前联系人范围的历史检索、受控 Skill 读取、业务结构化输出工具 | 由 scope setup 注册，闭包绑定 owner/contact；模型参数不能重新选择身份。内核本身不是工具清单。 |

官方 profile 层序为 bundle、profile patch、home patch、invocation overlays、telemetry switch：`apps/cli/src/profile-boot.ts:211-238,321-323`。应用自有 profile 也不能忽略 home 层；`prepareProfile` 会写空 `cordis.yml`（194-199 行），因此“零文件变化”不是正确断言，应禁止敏感运行正文并允许必要配置文件。宿主还调用 `installProxyFromEnvironment`（271 行之后），测试须隔离代理环境，证明请求去向。

**禁止激活清单**：session-log-deepseek、plugin-package-inventory-deepseek、OTEL exporter、JSONL session persistence、compaction/title、Shell/PTC/任意文件工具、子 Agent／自治任务、MCP 外部连接及聊天发送。官方 `sdk-minimal/cordis.patch.yml:20,23,140,168` 恰好默认启用前两种上传、persistent-bash、JSONL；它只是不叠加 base，绝不是本产品 allowlist。禁用遥测环境变量不能替代删除日志／包清单插件。fs-local 如某条实际功能需要，只能作为内部服务使用，不能自动搭配 tool-fs。fs-local 的发布 dependencies 含 koffi 3.1.1/chokidar 5.0.0；这也是安装闭包和激活工具清单要分开的例子。

## 新增 provider 边界与潜在阻塞

1. `llm-deepseek/src/host.ts:29` 将 `resolveUserId` 固定到 `getOrCreateAnonymousUserId()`；`identity/anonymous-user-id/src/index.ts:26,65-98` 在 DSH_HOME 保存 `.anonymous-user-id`，按路径进程内 memo。`llm-deepseek/src/adapter.ts:138-149` 每次发送 `x-deepseek-harness-user-id`，有 sessionId 时发送 `x-deepseek-harness-session-id`，另含 attributionHeaders。即使三类上传插件均未加载，此路径仍存在。它不是私人正文副本，但需独立审核是否属于业务必要元数据，02 不得声称完全无额外标识。公开 `DeepSeekAdapter` 接受 resolveUserId callback，但官方 API-key host 没有禁用该头的配置；是否选用公开 adapter seam 应由实现给出证据，不改核心或隐瞒行为。
2. `llm-deepseek/src/adapter.ts:138-147` 使用 Messages API 与 `anthropic-version: 2023-06-01`；`config.ts:217` 拒绝配置 protocol，要求 Messages-compatible baseURL。不能用 `/chat/completions` 假服务的成功证明该 provider；02 应使用本地 Messages 假服务，并核验未来真实配置的协议适配路径。
3. 图像／文件路径有 Files API 与 upload-index 写盘能力（`file-store.ts`、`upload-index.ts:135`），本产品运行统一为文字。02 应证明文本链路不会触发这些路径，而不是把包里存在相关代码等同于一定发生外发。不要为验证读取真实附件。
4. 官方 profile 有缺失 bundle 跳过机制（app-boot README Profiles 段），不是任何依赖缺失都自动阻止启动；健康检查必须确认必需业务插件和服务 ready，不能只依赖进程存活或 exit 0。

## 生命周期、结构化输出与提交边界

| 风险 | 公开扩展点与固定源码依据 | 02 必须实际证明 |
| --- | --- | --- |
| 创建信号不是运行信号 | `agent/src/index.ts:98-118` setup 在发布前；创建 signal 返回后解除 | 分别取消创建、模型等待、工具执行；不能仅传 create signal 就报完成 |
| 取消不是释放 | `agent-loop/src/index.ts:541-580` dispose 取消、等 idle、释放 scope、移除注册 | 等真实 quiescence；不合作工具迟到返回后也不得提交；清理 Session 注册须独立核验 |
| 不合作工具阻塞退出 | `tools/src/index.ts:1362-1372,1567-1598` 等待工具 promise；`apps/cli/src/process-shutdown.ts:4,54` 默认 5 秒强制退出 | 强制退出不是完整清理；测试 SIGTERM、重复信号、异常和挂起工具，区分 graceful 与 forced |
| structured helper 非公开 | `subagent/src/structured.ts` 的 attachStructuredRuntime 没有根导出；`subagent/src/index.ts:111` 只导出工具名常量 | 不 deep-import 内部 helper、不为 schema 增加子 Agent；公开 tools.register/guard/result＋concludeTurn 验证输出 |
| schema 合法不等于业务成功 | `structured.ts:96-105,119-153` 官方参考先校验暂存、concludeTurn，再等权威 tools/result 成功后 capture；公开接口见 `tools/src/index.ts:199,435,1144` | 无效字段／类型、无提交、重复提交、同批后续工具、post-policy 失败、纯文本结束均不得产出成功候选 |
| 迟到 PG 写入 | scope/cancel 不提供事务回滚；restrict 限继承全局工具，不自动过滤 scoped 注册（tools README） | 工具仅返回证据／暂存候选；最终事务复验 owner/contact、删除世代、请求资格、幂等及取消状态，跨联系人并发不得混用 capture |
| 预算与重试 | llm stream 不自行重试；llm-retry 是额外 agent-step 扩展 | 统计物理请求、错误、超时、取消和重试；无 title/compaction 隐式调用；预算不可只看最终成功次数 |

## 02 签收所需运行证据

1. 从真实 npm exports 经官方 profile 启动 TS 业务与 DSH 同进程，记录必需服务和模型工具 allowlist、Node／锁摘要；无需 Electron、打包或真实模型即可本地验证。
2. 两 owner × 两 contact 的合成并发、作用域销毁、删除／禁用后迟到结果拒绝。不得以配置检查替代执行攻击性参数用例。
3. 单次语义、完整工具循环和结构化输出错误矩阵；既测假 adapter 的统一运行合同，也测官方 provider 的本地 HTTP wire，二者结论分开。
4. 捕获全部请求（头＋正文＋目标），快照隔离 DSH_HOME 与工作目录，覆盖成功、错误、取消、正常退出、强制退出和重启。明确配置文件／匿名 ID／正文副本的差别；无 dsh_session_log、dsh_plugin_packages、OTEL／Files 意外请求，无 JSONL／隐式恢复。
5. 不合作工具、provider 和退出路径有有界失败，业务提交复验关闭所有迟到写入；对已发送请求照实记账，不能声称 abort 消除了供应商处理或费用。
6. 全依赖锁、安装脚本审查、公开 exports 真正导入与必要平台资源验证。上述未完成时 02 仍未验收；本文件没有替实现方打勾。

## 实际执行、数据影响与清理

已执行：官方远端 tag 查询；registry 元数据与 13 个 tarball HTTPS 下载；SHA-1/SHA-512、exports 目标、workspace dependency 转换、非编译材料比对；读取固定源码、README 与官方测试例子。未运行 DSH、未安装依赖、未执行官方 build／postinstall、未运行模型或 App，未接触私人资料、生产库、凭据和 `.env`。无外发聊天、push、提交或产品数据变化。本文件只由主会话纳入提交。

复查资料在 `/tmp/notalone-dsh-runtime-audit`，初始约 3.9 MiB；没有生成运行时缓存或构建物。其 JSON／tarball 是本次原始公开验证证据，为实现会话短期复核保留；共享官方源码 `/tmp/notalone-dsh-official-687f282` 未修改。开始时两个卷可用约 149 GiB。额外四包下载尝试遇 TLS EOF，未将其计入 13 包成功范围；对应 provider-api-key 等新增结论属于固定源码静态证据，未声称发行验证通过。

独立子 Agent 只读复核了七服务、profile、取消与结构化扩展点，未访问实现代码。文档最终检查核验本地引用文件、固定源码链接位置和尾随空白；这些是文档验证，不是运行验收。
