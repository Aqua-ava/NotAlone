# 同步减负 04：新来源证明上的恢复与认证回归

日期：2026-11-07。对应任务 04 的测试补充；本文件覆盖合成 SQLite 实例，不替代真实历史备份副本的迁移、重启与硬中断回放。

## 全量暴露的遗漏与删除修复

第一轮全量为 2202 项、2117 通过、84 失败、1 取消；按文件和用例名对照 02，新增失败身份 35 个。该轮发现尚未迁移的旧结构夹具、旧守卫资格断言及实际删除路径遗漏。审查修复与该轮执行重叠，因此只用作诊断记录，不作为最终冻结代码的通过证据；修复后重新跑全量。

- 未完成删除目标的 `holderKeys=[]` 与正式重新收集不一致。联系人／账号原操作跨 45→46 继续执行先得到 `deletion_target_conflict`，再按正式范围重建 holder 列表后通过。未改旧迁移 SQL。
- 无证明行的易失守卫必须进入删除目标；不能在排空 holder 前移除，否则正式释放会认为持久化失败并关闭存储。真实 DeletionService 先出现 `worker_failed`，再将证明行与易失守卫的并集纳入 `source_proof` 目标，排空后统一清除，相关 5/5 通过。
- 新增 1025 位联系人，分别有／无 1025 个易失守卫的完整整账号删除。先复现 `runtime_transaction_invalid`，移除人为 overlay 基数上限后可完成。固定 namespace、写事务、键边界、复制、回滚和提交后发布限制保留。核验活动联系人为零、合法 `deleted` 墓碑保留，按原 key 直查守卫为零。

```bash
node --test --test-timeout=60000 --test-name-pattern='真实DeletionService联系人删除过滤|删除恰逢Prepare前|整联系人删除同时清除|1025位联系人' backend-ts/test/sqlite-continuity-diagnostic-integration.test.mjs backend-ts/test/sqlite-history-recertify.test.mjs backend-ts/test/sqlite-source-proof-integration.test.mjs backend-ts/test/sqlite-source-guard-deletion-scale.test.mjs
```

随后 7 文件删除、认证、片段、守卫和存量清理相关组 **118/118 通过**（15.19 秒，无 force-exit）：

```bash
cd backend-ts
node --test --test-concurrency=4 --test-timeout=60000 test/sqlite-continuity-diagnostic-integration.test.mjs test/sqlite-history-recertify.test.mjs test/sqlite-history-recertify-async.test.mjs test/sqlite-history-resumable-slices.test.mjs test/sqlite-source-proof-integration.test.mjs test/sqlite-superseded-cleanup.test.mjs test/sqlite-history-guard.test.mjs
```

结构基线相应为 94 表、955 字段、193 组外键、120 触发器、304 CHECK、0 view；旧三表移除，其他现有表结构不变。大联系人图片同步合成夹具显式准备来源证明，1200 张图片／6936 次尝试与原黄金结果一致；12 次样本 P95 6.509ms，低于 100ms 目标。结构审计及图片相关 5/5 通过，未修改阈值或黄金结果。

根目录 `pnpm run typecheck` 因隔离工作树的依赖链接触发 `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`；改按两个包分别 `npm run typecheck`，均通过。没有为此改动主工作区依赖或源码。

账号变化的错误码还需进入诊断日志白名单。新增真实 `history.markContinuityLost` 集成用例先出现“围栏已提交、日志 0 条”，仅补固定 `history_account_changed` 后，诊断日志及领域集成 **32/32 通过**。仍拒绝任意错误文本与敏感载荷。

```bash
cd backend-ts
node --test --test-timeout=15000 --test-name-pattern='实际账号变化提交' test/sqlite-continuity-diagnostic-integration.test.mjs
node --test --test-timeout=15000 test/sqlite-continuity-diagnostic-log.test.mjs test/sqlite-continuity-diagnostic-integration.test.mjs
```

## 独立审查

固定点为已完成 02 的 `7b5def9bb26db2db1c0835332d38ca6341754a34`，范围含 04 未提交 diff 及新增文件。

- Standards：初审发现整账号运行态数量上限及账号变化诊断白名单遗漏；补充失败用例、修复并定点复审后，未解决问题 0。
- Spec：初审发现运行态数量上限及迁移中未完成删除 holder 列表不一致；修复后独立执行原操作跨版本删除，并补多目标／跨联系人覆盖，未解决问题 0。

审查覆盖迁移校验和、原子回滚、删除目标摘要、Worker 提交后发布、账号／联系人隔离及本机资料和新外部读取资格。审查结论不替代实际副本或桌面验收。

## 最终全量与基线对照

最终代码冻结后执行同一命令与并发度；804 个后端源码／测试文件的冻结摘要前后一致：`974d9f4b97b4d832bb8f29200a5e0ac8e9ea25c26dab0f590c54913110d8c49c`。

```bash
cd backend-ts
perl -e 'alarm 600; exec @ARGV' -- npm test -- --test-timeout=60000 --test-force-exit
```

| 对照 | 测试 | 通过 | 失败 | 取消 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| 02 固定基线 | 2170 | 2120 | 49 | 1 | 301.37 秒 |
| 04 与大库验收并行 | 2208 | 2158 | 49 | 1 | 334.33 秒 |
| 04 大库任务退出后 | 2208 | 2159 | 48 | 1 | 296.45 秒 |

按文件和用例名保留重复次数比较：02 有 47 个失败身份，最终 04 有 46 个，**新增失败 0**。原有嵌套失败与取消仍存在，完整测试进程退出码为 1，不能表述为全量全绿。旧 38→39 索引夹具改为明确历史模式后通过；这是夹具隔离修正，不宣称修复了无关产品问题。

并行一轮多出助手删除用例的既有 750ms 限时失败。保留原日志，不改时限；当前树和固定 02 树的最小并行复验均通过。大库验证全部退出后，用相同代码和命令重跑全量，该项 439.47ms 通过，最终新增失败为 0。没有通过更改测试分类、跳过断言或放宽时限消除失败。

本机日志：`.scratch/sync-simplification/backend-04-final-full.log`、`backend-04-quiet-full.log`；精确失败身份对照：`04-final-full-comparison.json`、`04-quiet-full-comparison.json`。它们只保留在端侧，不提交私人数据库或产物。

## 新观测接口

`backend-ts/test/fixtures/history/source-proof-snapshot.mjs` 导出 `snapshotContinuity(tx, ownerId, contactId?)`：

- `proofs` 直接读取 `source_proof`。
- `scopes` 仅投影已有会话／代次事实的旧五字段；`fences` 仅投影 `needs_confirmation` 的旧三字段。它们是测试断言的逻辑视图，不创建兼容表、SQL view 或生产读写路径。
- `guards` 与兼容名称 `leases` 都只返回 `tx.runtimeGet('history-source-guard', JSON.stringify([ownerId, contactId]))` 的实际易失对象。通过联系人表枚举，即使尚无 proof 也不会漏掉已有守卫；不凭持久资料合成 active／lost 守卫。
- `legacyTables` 从 `sqlite_schema` 查询旧围栏、范围、租约三表是否仍存在。

两个认证 snapshot registry 复用该接口；批量候选夹具改为直接建立新证明和切换 `ok`／`needs_confirmation`，查询计划检查相应改查 `source_proof`。没有改写旧版本迁移 SQL，历史结构夹具仍保留其真实旧表准备方式。

## 保留与新增的断言

- 专用认证 setup 确认每位联系人只有一条证明、围栏对应 `needs_confirmation`，且三张旧表不存在。
- 原地恢复主例和来源反例直接断言单条证明的 `ok`／`needs_confirmation`，同时继续检查绑定、授权、消息身份、每表水位、正文读取计数与来源隔离。
- 六种清单／durable 能力组合在重启后观察到实际 `guards=[]`，证明仍为单条 `ok`；下一次同步先核当前来源，再从已存水位续读。没有伪造旧 runtime 的 lost 租约。
- 幂等接纳、早取消、精确 key、原生关闭未排空、成功通知、失败回写、授权撤销、删除／清空／排除／终态、部分页后任务中断及来源变化反例继续通过。
- `ok` 的已接纳本机资料不依赖运行中的微信读取器或持久守卫。清洁关闭后的来源读取和记忆启动可直接使用证明；另行显式调用来源准备仍只核元数据、不重读正文。`needs_confirmation`、真实账号／会话／代次／物理目标变化及锚点冲突继续拒绝。
- 正常 FirstHistory 完成通知可直接确认已有完整证明，不为已完成资料再开读取器；后续增量仍按正常入口续接，消息、绑定和认证请求不复制。

## 最小失败与收敛

最小 in-place 用例在登记 46 后首先出现 `storage_invalid`，原因是测试 snapshot 仍查询已 DROP 的旧三表；接入新观测接口后通过。

相关组最初为 68/71：剩余三项仍把“进程守卫关闭”当作本机资料不可用，或要求已完成证明再打开读取器。按任务 04 的新合同改为正反双边断言：`ok` 资料可用且无需读者，真实来源变化／待确认仍拒绝。没有把需要当前原生守卫的正文读取门改为无条件允许。

## 实际验证

在 `backend-ts/`：

```bash
node --test --test-timeout=10000 --test-name-pattern='围栏元数据一致时原地恢复' test/sqlite-history-in-place-recovery.test.mjs
node --test --test-timeout=15000 --test-name-pattern='原地恢复完成后干净重启|来源认证完成清洁关闭|派生来源元数据就绪拒绝' test/sqlite-history-recertify-restart.test.mjs test/sqlite-history-recertify.test.mjs
node --test --test-timeout=15000 --test-name-pattern='ok来源不依赖持久租约|派生来源元数据就绪拒绝' test/sqlite-history-recertify.test.mjs
node --test --test-timeout=15000 --test-name-pattern='ResumeComplete后completed稳定|成功通知接真实|历史记忆直接使用' test/sqlite-history-recertify.test.mjs test/sqlite-history-recertify-async.test.mjs
node --test --test-timeout=20000 test/sqlite-history-in-place-recovery.test.mjs test/sqlite-history-recertify.test.mjs test/sqlite-history-recertify-async.test.mjs test/sqlite-history-recertify-candidates.test.mjs test/sqlite-history-recertify-preflight.test.mjs test/sqlite-history-recertify-restart.test.mjs
```

最终相关组：**71/71 通过；失败 0、取消 0、跳过 0，约 8.43 秒**。只有测试和夹具改动；未降低原有全局测试时限或测试分类。后续全量与基线对照由主 Agent 记录。

## 数据影响与限制

全部操作仅发生在临时合成库，包含真实 Worker 事务、领域删除、关闭与重启；原生渠道是显式合成替身。中断测试在领域任务未收尾时关闭存储 Worker，不能替代真实副本上的 OS 硬终止验收。

没有对真实业务库写入，没有操作或重启真实 App、微信、真实读取器，没有真实模型调用或外部聊天发送。测试快照仅限本机测试进程，不上传，不含真实联系人姓名或聊天内容。此结果不证明真实备份回放、迁移耗时、实际桌面交互或完整原生协议已验收。

## 本机回复与资料资格补充

四个文件相关组：`sqlite-reply-provenance.test.mjs`、`sqlite-reply-source-recovery.test.mjs`、`sqlite-memory-documents-deletion.test.mjs`、`sqlite-reply-frozen-document-tool.test.mjs`。

专用夹具使用 `simulateSourceGuard` 在当前 Worker 内模拟 lost、旧 runtime、恢复 active；它从真实 verified binding 派生守卫，不创建旧租约表，不修改 `source_proof`。`sourceRecoveryTest.ready` 仅恢复易失守卫，不能解除待确认状态。

本轮保留以下正负双边：

- `proof=ok` 的已保存来源可在 lost／旧 runtime 后使用，模型入口不等待微信准备器；同请求回放不再生成。另行置为 `needs_confirmation` 后，即使易失守卫回到 active，新请求仍被拒绝、旧候选撤下，外部准备器未被调用。
- 正式 `contacts.revoke` 撤销的是读取 grant 和 selection 资格：`contacts.eligibility` 与正式历史同步入口均返回 `read_not_authorized`，读取授权不会因使用本机资料而恢复。稳定绑定尚未撤销且此前已接纳的 `ok` 资料仍可合法使用，这是既有读取授权／本机资料边界，不是新增授权。
- 真正的 `binding.state=revoked` 继续使来源核验失败，候选页返回 unavailable 且不显示正文。同请求仍可核对无正文的幂等收据；该收据不会重新产生模型请求或恢复旧正文。
- 冻结后的文档工具继续使用原 publication 和版本；后来发布的新集合、同步关闭与 guard 丢失不改变本轮实际依据。真实事实纠错、来源删除、冻结集合成员损坏仍拒绝旧正文。
- 多来源依赖、较早纳入的运行上下文、跨联系人本人资料及单消息版本修订仍核验；独立用户输入与无关联系人不被扩大失效。
- 文档删除与在途排空的原有测试未放宽：引用来源、跨轮继承、本人混合资料、独立文档、零成员发布、真实输入追踪及受影响来源不同物理出现均保留回归。

最小红例首先证实旧断言把 guard 丢失误作已保存来源不可用，或期待严格文档读取器返回空。按当前新表合同改为核验本机资料保持原身份；真实失效的负例继续拒绝，没有修改产品代码放宽它们。

```bash
cd backend-ts
node --test --test-timeout=10000 --test-name-pattern='本机回复忽略 lost|同步关闭且守卫已失证' test/sqlite-reply-source-recovery.test.mjs test/sqlite-reply-frozen-document-tool.test.mjs
node --test --test-timeout=10000 --test-name-pattern='撤销读取授权后|绑定撤销后幂等' test/sqlite-reply-source-recovery.test.mjs
node --test --test-timeout=20000 test/sqlite-reply-provenance.test.mjs test/sqlite-reply-source-recovery.test.mjs test/sqlite-memory-documents-deletion.test.mjs test/sqlite-reply-frozen-document-tool.test.mjs
```

最终四文件组 **34/34 通过，失败／取消／跳过均为 0，约 18.36 秒**；`git diff --check` 通过。provenance 与 documents-deletion 测试的原断言无需改动，继续完整执行。自定义测试动作触发围栏时，诊断入口白名单会输出 `history_continuity_diagnostic_unavailable`；本组不构成正式日志入口验收，也没有放宽该白名单。

本组仅使用临时合成库及合成模型接口／本机回环 HTTP，没有真实供应商模型调用、外部凭据或真实微信读取；未操作真实业务库或 App。未运行全量测试，尚不能据本组证明真实副本迁移、原生读取器或桌面交互通过。


## 守卫、删除与空事实恢复补充

`sqlite-history-guard.test.mjs` 首轮为 19 通过、13 失败，失败集中于旧持久租约语义以及查询旧三表的 SQL 假实现。两段私有 SQL 形状测试改为专用 registry 上的公共 Storage action：空 proof 恢复只清除本联系人空事实及易失 guard，其他联系人的消息、捕获、目标及排除项不变；本联系人有排除项时拒绝清理，抑制不被擦除。

普通 stop、后台 loss、Worker 重开和暂时原生不可用不再使合法 proof 进入 `needs_confirmation`。重新核验相同元数据后可续读，旧 guardId 仍不能跨运行代次复活。旧模式下账号、会话、来源代次、物理表实例变化四个反例均不进入新正文页，证明进入待确认，既有消息保留。停读授权、在途 abort、迟到页拒绝、竞争申请、1001 页续读、资源关闭失败重试、来源删除抑制及跨联系人真实失效保护继续执行。

新增公共删除红例发现：尚无 `source_proof`、仅有易失守卫的联系人，删除完成后原实现残留 Map。修复在 contact／account 删除的 fence 阶段按仍存在的联系人清除易失守卫，独立于持久 proof target 是否存在，且沿用事务 overlay。最小红例转绿；无 proof 的联系人删除和整账号删除两分支均直接按原 owner/contact key 断言 guard 已移除，并检查外键完整。该检查不依赖已被删除的联系人表枚举，因此能发现此前快照遗漏的残留。

```bash
cd backend-ts
node --test --test-force-exit --test-timeout=15000 --test-name-pattern='预目标空proof|本联系人已有排除时空proof' test/sqlite-history-guard.test.mjs
node --test --test-force-exit --test-timeout=15000 --test-name-pattern='没有持久来源事实' test/sqlite-history-guard.test.mjs
node --test --test-timeout=15000 test/sqlite-history-guard.test.mjs
```

空事实正反例 2/2；无 proof 删除两分支 2/2；最终单文件 **38/38 通过，失败／取消／跳过均为 0，约 8.2 秒**，最终命令未使用 force-exit。`git diff --check` 通过。全部数据均为临时合成库，测试完成后清理，没有真实库、App、微信、读取器配置或主工作区源码写入；真实副本生命周期另见相应回放记录。

## 历史引用迁移与存储兼容补充

v25 引用迁移用例先因现代同步动作依赖新来源事实而无法构造旧历史。`v25-quote-registry.mjs` 改用 test-only 历史 DDL 种入合成授权身份、连续性范围、读取目标、消息来源、引用及 attempt；明确断言旧库为版本 25，旧三表仍在且 `source_proof` 不存在，再由正式迁移升级。没有向产品加入旧表分支或兼容 view，正文、来源关联及版本去重断言保留。

原重启后无活 guard 即拒绝 `quote.save` 的断言按新合同改为正反双边：`ok` 证明的本机资料在重开后可保存；另一联系人进入待确认后候选为空、保存被拒。没有修改产品资格逻辑放宽真实失效保护。

```bash
cd backend-ts
node --test --test-force-exit --test-timeout=15000 test/sqlite-history-quote-store.test.mjs
node --test --test-force-exit --test-timeout=60000 test/sqlite-storage*.test.mjs
```

引用整组 **9/9**；存储相关三文件 **26/26**，约 68.6 秒，含 busy、异常／中断回滚和时间预算。相关条件未变化，存储结果复用、不重复执行。本组只处理合成测试及临时数据库；不证明真实副本迁移、完整原生协议或桌面交互已验收。全量与固定基线对照由主 Agent 另行记录。


## 未完成删除迁移的多目标复审

扩充 `sqlite-source-proof-deletion-restart.test.mjs`：同一联系人准备两个读取目标，后插入的较大 ID 带更早的 `created_at`；账号分支再加入第二位合成联系人及其来源目标。联系人分支因此有两个 goal／一份 proof，账号分支有三个 goal／两份 proof。

45→46 后，迁移账本中的完整 `source_proof` 删除目标与正式历史域收集器逐项比较，包含实际 `holderKeys` 顺序；再沿原 `operationId` 调用正式 `DeletionService.advance`，确认完成且所有相关 proof／goal 均清空、完整性及外键通过。没有创建新删除计划掩盖原目标冲突。测试采用正式历史域及删除协调器、合成删除权限；不代替其他领域的完整删除回归。

```bash
node --test --test-timeout=15000 backend-ts/test/sqlite-source-proof-deletion-restart.test.mjs
```

扩充后 **2/2 通过，失败／取消／跳过均为 0，约 7.1 秒**，未使用 force-exit；`git diff --check` 通过。此轮仅修改专用测试、夹具和本记录，没有修改迁移 SQL 或其校验和。临时合成库关闭并清理，无真实库、应用或读取器操作。


## 正式渠道、停车交接与来源准备补充

第一次全量暴露三个文件仍按旧持久守卫语义断言：`sqlite-wechat-history-channel.test.mjs`、`sqlite-history-parked-sync-handoff.test.mjs`、`sqlite-history-source-preparation.test.mjs`。适配后直接查询新 `source_proof` 状态，并同时检查外部正文资格、实际 resolve／page 请求及消息身份，避免只改 phase 字段掩盖读取门。

- 正常释放、合成原生进程硬退出、旧制品图片失败导致的共享进程停止：本机来源仍为 `ok`，保存覆盖和消息身份不回退，`bodyAvailable=false`；重新建立外部读取时先核账号、会话和来源，不复活旧进程或凭展示字段恢复资格。
- 单图隔离仍保持进程与读取守卫；未声明隔离的旧制品仍终止进程并使全部外部守卫失效。10／100 联系人对照均保持全部本机 proof 为 `ok`，无额外历史正文页；真实来源错误仍结束共享读取。下一次逐联系人核验发现 wrong-account 时，仅对应证明进入待确认，其他空闲联系人不因共享错误码被推断为来源变化。
- parked 账号、会话、来源代次三项反例保持新正文页为零、旧来源不可用且对应 proof 为 `needs_confirmation`。真实表实例变化、坏边界／超限 tail 拒绝、未认证能力零 RPC、授权撤销、取消与资源排空等原保护继续通过。
- 协调器在失守卫后可以完整元数据核验并建立新目标，交接给 FirstHistory；恢复资格查询故障注入移动到本轮实际执行的公共 `history.readPreflight` 动作，继续验证查询失败不启动渠道、下轮重试恢复。

真实产品缺陷单独做红绿：正式渠道 resolve 返回错误账号时抛 `history_account_changed`，但来源失效错误集合遗漏此码，导致读取虽拒绝、旧来源仍被视作有效。原有 parked wrong-account 公共反例先报 Missing expected rejection；只将该码加入 `lostCodes` 后 wrong-account／wrong-generation 2/2 通过。未将 `history_native_unavailable`、`history_source_unverified` 或其他瞬态码加入来源失效集合；新增 wrong-conversation 及逐联系人来源复验反例一并通过。

```bash
cd backend-ts
node --test --test-timeout=15000 --test-name-pattern='parked联系人重新查证发现wrong-account' test/sqlite-wechat-history-channel.test.mjs
node --test --test-timeout=15000 --test-name-pattern='parked联系人重新查证发现wrong-' test/sqlite-wechat-history-channel.test.mjs
node --test --test-timeout=15000 --test-name-pattern='准备来源复用活守卫|空闲守卫瞬时|恢复查询失败后|合成原生进程意外|共享parked|parked联系人重新查证发现|来源类图片错误|正式渠道拒绝带额外' test/sqlite-history-source-preparation.test.mjs test/sqlite-history-parked-sync-handoff.test.mjs test/sqlite-wechat-history-channel.test.mjs
node --test --test-timeout=15000 test/sqlite-wechat-history-channel.test.mjs test/sqlite-history-parked-sync-handoff.test.mjs test/sqlite-history-source-preparation.test.mjs
```

最小适配组 10/10；最终三文件组 **57/57 通过，失败／取消／跳过均为 0，约 45.84 秒**，未使用 force-exit。`git diff --check` 通过。仅使用临时合成 SQLite 与 Node 合成原生子进程，SIGKILL 目标只来自本夹具 pid 文件；未操作真实微信、App、真实读取器、真实业务库或主工作区源码，没有模型请求或外部聊天发送。该结果覆盖渠道集成和本机资格，不能替代真实备份副本生命周期回放；没有扩大到全量重跑。

## 真实旧结构升级夹具补充

旧 31／35／37／38／41 库此前截断迁移，却复用了已切到 `source_proof` 的现行动作，首次历史同步因此 `storage_invalid`。测试专用 `pre-source-proof-registry.mjs` 现固定使用完整来源 `7b5def9bb26db2db1c0835332d38ca6341754a34`：

- 仅 legacy 模式通过本机 `git -C <仓库> archive` 导出该提交的 `backend-ts/src`，加载当时的注册表和动作；不联网、不回退到 HEAD。当前模式仍使用正式现行 46 注册表。
- 原始迁移 SQL、校验和及旧结构保持原样；旧错误只在测试 Worker 的传输边界转换为同错误码的当前异常类。
- 旧 31／35 的合成渠道在旧库中按当时 normal-use 合同独立核对账号和固定目标，再由旧正式动作自然保存事实；升级后由正式 46 迁移得到 `ok`。没有在旧库偷偷添加 proof，也没有在升级后补写来源资格。
- 38→39 待处理索引测试使用显式历史 `index39` 模式，保留单项迁移和查询计划验收；`current` 不再被误称为 39，仍为 46。
- 41→46 核对自动处理默认关闭、原消息不变、前 41 条迁移账本逐项不变及三旧表真实存在→DROP；31／35／37 同样观察到旧三表且无 proof，升级后仅新证明，资料和既有校验和保留。
- 当前 46 上 guard 关闭不产生本机资料的 pending 标记，也不阻止合法修正。真实来源删除仍隐藏正文并拒绝后续依赖写入；37 的旧空时间缓存由后续迁移重建，原账本不修改。冻结文档的版本、发布成员和事实纠错保护继续保留。

导出按 Worker 缓存、以独立 `mkdtemp` 路径隔离并发。主清理 `after` 只在五个 Node 测试主入口注册（标准进程隔离运行的 `isMainThread`）；Worker 注册表不注册该 hook。主进程只读取本 PID 的精确导出清单，并验证路径前缀、目录实路径及 marker 的 PID／固定提交后删除，不扫描删除其他 PID 的并行测试目录。Worker 的退出回调只清理其自己的单个临时目录。

实际发现 Worker terminate 可能跳过退出回调后，补了上述主进程收尾。此前 4 份仅含固定旧源码和依赖链接的自有导出目录，经目录清单、链接目标和固定提交 registry 内容核对后精确清理；最终复跑后，临时导出目录与 PID 清单残留数为 **0**。

```bash
cd backend-ts
node --test --test-timeout=20000 --test-name-pattern='图文引用迁移|41升级45' test/sqlite-memory-content-upgrade.test.mjs test/sqlite-memory-auto-switch.test.mjs
node --test --test-timeout=30000 test/sqlite-memory-auto-switch.test.mjs test/sqlite-memory-content-upgrade.test.mjs test/sqlite-memory-management-upgrade.test.mjs test/sqlite-memory-pending-index.test.mjs test/sqlite-memory-timeline-guard.test.mjs test/sqlite-reply-local-documents.test.mjs
node --check test/fixtures/sqlite/pre-source-proof-registry.mjs
```

最小旧断言先红；最终六文件组 **17/17 通过，失败／取消／跳过均为 0，收尾修订后复跑约 9.58 秒**。35 的已发布 checksum、旧账本、40 条来源公开投影、删除 blocked→completed 和独立资料保留均继续断言。`git diff --check` 通过。

本组没有产品改动，没有真实模型或微信请求、真实库写入、App 操作、打包或远端操作。合成模型返回仅用于构造迁移所需的旧资料，不是质量验收。测试环境须保有上述固定 Git 对象及已安装依赖；浅历史快照缺少该对象时应补齐测试来源，不能改用当前动作或伪造旧 DDL。全量对照由主 Agent 单独执行。
