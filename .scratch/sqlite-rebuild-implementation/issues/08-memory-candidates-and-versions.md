# 08：记忆候选、版本与修正

Triage: ready-for-agent
State: claimed
Type: task
Parent: [同步、聊天清空与记忆处理规则](../../sync-memory-behavior/spec.md)、[SQLite数据库重建](../../sqlite-database-rebuild/spec.md)
Blocked by: [07 固定范围的记忆提取与核验](07-fixed-scope-memory-extraction.md)

> 2026-10-29已批准发布，未开始实现。[任务索引与共同约定](../planning.md)。

## 交付行为

用户能查看提取产生的固定候选原稿及依据，明确采纳、修改、拒绝、修正和撤销合法自动更新。正式记忆保留独立身份、不可变版本和真实决定；本人及联系人资料共用模型而保持范围隔离，来源删除和当前人工保护持续生效。

## 验收条件

- [ ] 经07正常流程产生候选，记录真实产生执行、范围与固定模型原稿；不建立采纳前多稿历史，不原地改写原稿，也不承诺未提交编辑草稿跨重启恢复。
- [ ] 查看候选可回到必要消息及实际来源；待核验、拒绝、已采纳分别可见，未核验候选不得冒充已确认事实进入普通检索或生成。
- [ ] 明确采纳或修改并采纳时，保存真实 `memory_decision`并产生正式 `memory_version`；决定、候选、范围和目标版本相互匹配，不由伪造决定或孤立版本绕过流程。
- [ ] 本人和联系人使用共用记忆／版本结构并严格核验范围形状；本人资料保留每个贡献联系人及其真实来源，联系人资料不能引用他人输入。
- [ ] 当前记忆指针、版本号、决定和依据在同一短事务提交；并发修改按当前头修订和预期版本CAS拒绝冲突，不静默覆盖新版本或更新错误记忆。
- [ ] 自动采纳与更新必须有合法必要消息、来源语义核验及 `auto`来历，支持明确撤销，不冒称用户确认；来源不足或核验未完成不得发布正式版本。
- [ ] 修正错误与记录变化沿既有语义区分，保留形成和操作顺序；旧错误／已失效版本不再作为当前事实使用，历史可见性仍服从来源删除。
- [ ] 撤销仍可合法恢复的自动更新时，在同一记忆下新增恢复版本并记录被恢复版本及原前驱，不直接回拨或覆写旧版本，不把自动内容变成无来源手录或用户确认事实。
- [ ] 恢复与自动更新均复验当前来源、范围、预期头修订和当前人工保护；当前保护归记忆头，由真实保护／解除决定变更，不从旧版本形成快照恢复旧保护。
- [ ] 通过05清除失去必要来源的候选、版本正文、决定敏感材料及派生依赖，覆盖本人跨联系人来源闭包；其他合法来源不能替换旧依据保住已失效证明，合法独立手录不被无关删除误删。
- [ ] 正常界面反馈区分采纳成功、拒绝、修正、合法撤销、并发冲突及来源失效；旧操作重复提交返回原结果或明确拒绝，不能重新执行或复活已删版本。
- [ ] 隔离正常入口覆盖模型原稿到修改采纳、auto撤销新增版本、并发保护变化、两联系人／本人隔离及来源删除后的晚到采纳／恢复；检索到的当前版本与界面一致，删除内容不可检索或回写。

## 验证与证据

使用07产生的合成候选，经正式记忆管理接口、真实SQLite事务和既有具名桥／页面完成查看、采纳、修正、保护及撤销，不直接构造已采纳结果作为唯一证据。先运行最小版本／决定／CAS用例，再扩展相关管理、检索与05删除回归；记录调用来历、状态、界面反馈、清理和未覆盖项。

以两份父规格及统一设计中的记忆、候选、版本、决定和必要消息合同为唯一模型依据。测试只验证已实现的可观察行为；自动语义质量、真实微信资料和完整管线不能由本票结构验证代签。

## 范围与执行门禁

- 本轮仅发布任务，不启动实现。`ready-for-agent`表示任务信息可供后续处理，执行仍须用户另行明确下达实现指令；本任务不授权读取私人资料、调用模型或切换／清理真实业务库。
- 适用[实施索引公共约定](../planning.md)和两份父规格；数据库实体、键、状态及事务以[唯一统一设计](../../sqlite-database-rebuild/greenfield-design.md)为准，不采用早期讨论稿的并行结构。新增敏感资料及本人跨联系人依赖均接入[05来源删除与清理](05-source-deletion-and-cleanup.md)，不能只靠隐藏或移除单条引用声称已删除。
- 后续开发只用 `pnpm run dev`，先执行 `dev:status`核验并复用实例；不得擅自打包、运行旧包、修改发布门禁、推送或创建远端分支／PR。
- App首次使用继续搁置；组件安装、新模型设置、干净机器和发布、微信迁移／恢复实验均不属于本任务。不新增模型或凭据入口，沿现有配置核验用途与最小文本出站授权。
- 合成结果与真实模型、真实微信、产品集成分别记账。当前未核验的真实账号／联系人读取范围不可读取；不发送外部消息，不把开发验证能力加入产品工具。

## Comments

### 08 离线合同检查点

- Goal 已实际创建为 active，任务保持 claimed；依赖 c8e926ef 与 9b3541b3 已用 merge-base --is-ancestor 核验。
- 已落受版本管理源码：`backend-ts/src/memory/sqlite/management/knowledge.ts` 导出 `createMemoryKnowledgeReader({includeUnconfirmed:false})` 和默认 `memoryKnowledgeReader`，实现12的 `ReplyKnowledgeReader`。本人 `self` 显式映射 `owner`；正式版本 `kind=memory`、auto/confirmed，候选 `kind=memory_candidate`、unconfirmed；额外 `headRevision:bigint` 随 identity_json 保存，复验版本、头修订、精确来源、正文与资格。拒绝、来源/范围失效内容不进入生成。
- `management/service.ts` 提供 `importRun/read/decide/automatic`；system入口不开放HTTP或Tool。下一迁移工厂 `memoryManagementMigration(version)` 当前聚合追加11，不改1..10；05显式注册增加 `memory_management`。
- 当前最小真实SQLite/07合成正常供应商用例5/5及backend typecheck通过，尚未作为最终验收；无新外部模型、无微信/桌面启动。
- 待root集中登记：`backend-ts/test/sqlite-memory-management.test.mjs` 建议 current（backend Node集成）；`backend-ts/test/fixtures/memory-management/supplier.mjs` 与 `registry.mjs` 建议 fixture/support。inventory本票未写。
- host公共文件未改。将提供只消费现有共享模型的处理结束hook和独立认证管理HTTP；12可组合本reader与09 reader，不另建memory表。

核心复核补强：独立Spec审查复现本人B产物经人工修正后丢失A冻结贡献删除依赖，已补递归前驱/恢复闭包及回归；Standards指出本域全owner扫描，现改来源索引反查。正式知识合同将语义 `citationSources` 与冻结资格 `qualificationSources` 分开，`sources`为精确依赖并集供12闭包，不把资格来源伪称证据引句；完整本人M:N依赖和每条record/revision复验。决定展示按持久CAS头修订排序，不以毫秒时钟或随机id表示真实操作顺序。最终核心6/6、backend typecheck、diff --check通过；Standards窄复核0新增，Spec确认原P1关闭，后续宿主/界面与消费者组合继续验证，State仍claimed。

宿主接线检查点：实际merge root `97aebf8d`，保留12 `candidateTurns.configurationFor` resolver。正式reader实际安装点是Worker registry的 `createReplyCandidateActions(memoryKnowledgeReader)`，无需给主线程候选宿主增加无效reader壳。认证管理HTTP和07处理结束 `afterRunSettled→publishRun` 已落盘，使用现有sharedModel/provider/arbiter，不新增模型调用；共9/9管理/认证/实际08→12消费者组合与backend types通过。组合由07正常合成supplier形成正式本人记忆、12正常DSH环回生成，05删除A后B讨论候选清空且请求未增加，非预塞已采纳结果。

新增待root分类：`backend-ts/test/sqlite-memory-management-http.test.mjs`、`backend-ts/test/sqlite-memory-reply-integration.test.mjs`（current Node）；`desktop/tests/sqlite-memory-management.test.mjs`（safe-node）、`desktop/tests/sqlite-memory-management-view.test.mjs`（headless）。桌面独立组件/桥及入口13/13；真实App尚待本次已获短lease。07旧正式profile的formalMemoryRows断言随正常自动发布变为12，未重跑旧4/4流程；本票新增窄hook与写者消费者组合验证发布和删除，新真实质量认证仍未知。
