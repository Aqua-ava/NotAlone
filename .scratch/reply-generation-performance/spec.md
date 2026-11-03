# 候选回复生成准备延迟优化

Triage: ready-for-agent
State: open

> 状态：2026-11-04 完成现象复核、存储耗时采样和 SQL 原型测量；本文件只定方案，未修改业务代码。
> 范围：优化“用户点击帮我表达／帮我想下”到本地生成器真正开始工作之间的等待，重点解决后台读取占用 SQLite 单写者队列。
> 不在本规格内：模型网络速度、DSH Skill 自动预载、最近聊天 50 条上限、消息排除交互、旧讨论语义、关系资料抽取质量、UI 重设计。
> 相关规格：新回复不自动带入旧讨论已由[新回复与旧助手讨论隔离](../new-reply-discussion-isolation/spec.md)另行确定。

## Problem Statement

生成候选前存在不可接受的等待：本地准备阶段曾耗时约 31.9 秒，用户看到“正在整理本次资料…”，但实际不是在等模型，而是在等同一 SQLite 存储线程中的后台查询结束。

该问题会随本地联系人和图片数量增长而恶化。用户不应因为后台图片同步、记忆管理页读取或其他长查询而等待几十秒；本机准备阶段应稳定在秒级，正常目标为 1 秒内。

## 已测基线

`2026-11-04` 的一次候选请求（不使用正文作为诊断材料）：

| 阶段 | 实测 |
| --- | ---: |
| 请求开始 → 运行时目录建立 | 4.810 秒 |
| 运行时目录建立 → 首个 DSH 会话事件 | 31.871 秒 |
| 两次模型物理调用合计 | 4.623 秒 |
| 最后一次模型返回 → 请求失败/收尾 | 2.184 秒 |
| 请求总耗时 | 49.460 秒 |

同一天较早的一次同类启动只有 3.122 秒的运行时目录 → 会话间隔，说明 30 秒不是固定的 DSH 启动成本，而是运行时环境变化或后台存储负载造成的动态排队。

`storageTiming` 在一次现场采样中记录到：

- `memory.read`：约 7.7 秒
- `media.imageSyncTargets`：约 3.4 秒
- `media.imageRefreshPending`：约 3.4 秒
- 多个长读查询连续占用同一个 SQLite worker

本地规模已达到数百个联系人、数千条图片消息。该规模不是测试夹具，因此方案必须先解决同类规模下的可重复性，不能只优化空库。

## 根因

### 1. 主存储线程被后台长读占住

`SqliteStorage` 的主 worker 串行执行读写动作。生成请求在启动运行时前需要执行 `runtime.incorporate` 等动作，后台图片同步和记忆读取也走同一 worker；前者会在后者结束后才能开始。

### 2. 图片同步查询存在重复计算

`backend-ts/src/media/sqlite/image-sync-actions.ts` 的 `workSql` 中，`preparation` 的 legacy cutoff 使用相关子查询：

```sql
p.rowid > coalesce((
  SELECT max(s.rowid)
  FROM media_extraction_attempt s
  WHERE s.owner_id = p.owner_id
    AND s.contact_id = p.contact_id
    AND s.adapter_version <> ...
    AND s.goal IN ('extract', 'original_upgrade')
), 0)
```

在 PostgreSQL 式的直觉下它看起来只是一次查找，但 SQLite 会针对 `media_extraction_attempt p` 的每一行反复执行该相关子查询。一个含约 1.2k 图片、约 5.7k 次提取尝试的联系人上，单次查询实测约 6 秒。

同一查询把 legacy cutoff 提前计算为一个 CTE 后，原型实测单次的冷结果约 70ms；同一只读连接上预热后，对本地全部数百个联系人重复执行该查询合计约 34ms。差异量级足够大，必须作为第一优先修复，但必须配合数据等价验证。

### 3. 图片同步在一轮中重复扫描

`SqliteImageSyncCoordinator` 对每个联系人先调用 `media.imageSyncTargets`，处理完目标后再调用 `media.imageRefreshPending`；两个动作都执行同一套 `workSql`。在长查询未优化时会重复支付完整扫描成本。

### 4. 记忆管理读取也在主存储上

`SqliteMemoryManagement.read`／`readHistory` 当前也通过主 `SqliteStorage` 执行。即使图片查询优化，大型记忆列表仍可能阻塞候选写入。

## Solution

### A. 将 legacy cutoff 改为一次性计算

在 `image-sync-actions.ts` 中把相关子查询提升为单独的 `legacy` CTE：

```sql
legacy AS (
  SELECT coalesce(max(s.rowid), 0) cutoff
  FROM media_extraction_attempt s
  WHERE s.owner_id = ?
    AND s.contact_id = ?
    AND s.adapter_version <> ?
    AND s.goal IN ('extract', 'original_upgrade')
)
```

`preparation` 通过 `CROSS JOIN legacy` 只比较一次 `p.rowid > l.cutoff`，再按原条件聚合。参数顺序、空 cutoff、已有 legacy 记录、同一联系人多个 legacy attempt 等语义必须逐项验证。

这是低风险、局部、可独立验证的第一步，不改变图片同步的外部结果。

### B. 增加后台只读通道

复用 `SqliteStorage.openReader(actionNames)` 的既有隔离机制，新增一个宿主生命周期内的 `backgroundReads` 只读通道，只允许：

- `media.imageSyncTargets`
- `media.imageRefreshPending`（若第一步后仍需保留）
- `memory.read`
- `memory.history`

具体依赖设计：

- `SqliteImageSyncCoordinator` 的目录查询依赖收窄为 `Pick<StorageReader, 'execute'>`，不再直接依赖可写 `SqliteStorage`。
- `SqliteMemoryManagement` 的 `read`／`readHistory` 走只读通道；`prepareTimeline`、决定写入和其他写动作继续走主 worker。
- 宿主关闭顺序增加 `backgroundReads.close()`，与现有 `assistantReads` 一样参与排空和失败重试。
- 主 worker 仍是唯一写入口；不接受页面传入 SQL、动作名、连接或任意 reader。
- 读取快照与删除/撤销的既有 lease、来源核验和迟到结果拒绝语义保持不变。

预期结果：后台图片/记忆长读即使仍在执行，也不会阻塞候选的 `runtime.incorporate` 和后续写入。

### C. 在测量后决定是否合并图片同步动作

SQL 修复先单独完成并测量；若 `imageSyncTargets` 和 `imageRefreshPending` 每次仍导致明显的重复扫描，再增加一个单次读取动作，返回：

```ts
{
  targets: ImageTarget[];
  pending: boolean;
}
```

由一次 `workSql` 扫描同时提供本页目标和是否还有未完成工作，协调器不再固定调用两个重复动作。不要在没有新基线的情况下直接扩大接口改动。

### D. 保留可诊断的阶段边界

不新增持久正文或扩大隐私数据：

- 继续使用 `storageTiming` 的动作名、排队时间和执行时间诊断。
- 自动化基准使用合成数据库、合成联系人和合成图片消息。
- 真实 App 只记录耗时和阶段，不记录聊天正文、图片内容或模型输入。
- 在实施记录中分别报告 SQL 执行时间、存储排队时间、候选准备时间和模型时间，不能用一个总耗时替代原因归属。

## 目标与验收指标

### 交互目标

- 本机准备阶段（请求受理到首次模型发送前的本地工作）P95 ≤ 1 秒。
- 同一阶段单次最大值 ≤ 2 秒。
- 模型网络耗时单独统计，不用它解释或掩盖本机排队。
- 后台图片同步运行时，候选请求不得等待单个后台查询超过 1 秒。

### 查询目标

在合成的“大联系人”夹具（至少约 1,200 条图片消息、约 5,000 次提取尝试）上：

- `media.imageSyncTargets` 或替代动作 P95 ≤ 100ms。
- 不得出现随消息数 × 尝试数增长的 `SCAN` 相关扫描。
- 原实现与新实现的结果集合、目标顺序、`hasPending`／刷新语义一致。

### 行为不变

- 最近聊天和关系资料范围不变。
- 图片同步的授权、来源、去重、失败退避和删除语义不变。
- 记忆管理页展示、分页和决定写入门槛不变。
- 模型调用次数不因本方案增加；Skill 轮次优化不属于本规格。

## 测试决定

### 已选公开 Seam

1. **图片同步动作**：通过合成 SQLite 数据集和公开 `media.imageSyncTargets` 契约验证新旧结果一致、空 legacy cutoff、已有 legacy 记录、分页／pending 和性能。
2. **图片同步协调器**：用一个可控慢读通道占住后台查询，同时用主存储执行前台写动作，断言前台动作不等待后台读取完成。
3. **记忆管理服务**：验证 `read`／`readHistory` 使用只读通道，`prepareTimeline` 和决定写入仍走主存储；范围、分页和失败错误码不变。
4. **候选生成准备**：使用合成 provider 和合成 SQLite 夹具，断言后台图片／记忆读取进行中时，候选从受理到 provider 收到请求仍能在一秒内完成。
5. **真实开发 App**：复用 `pnpm run dev`，在相同联系人、相同合成输入和相同热更新实例下比较修复前后的准备阶段；不发送微信外部消息，不打包。

### 最小 RED → GREEN

1. 先构造一个大联系人查询耗时／结果回归；把旧相关子查询替换为 legacy CTE 前，验证性能断言失败。
2. 构造一个持有后台读的队列测试；旧实现让前台写入等待，新实现让前台写入完成。
3. 验证 `memory.read` 使用只读通道而 `memory.prepareTimeline` 使用主 worker。
4. 最后运行候选准备集成用例，避免只证明 SQL 变快却没有改善用户等待。

## 实施切片

### 切片 1：可重复基线

- 增加或复用只读本地基准脚本，测量原始查询、legacy cutoff、每联系人扫描和全部联系人扫描。
- 记录旧实现的 P50／P95／最大值及结果数量。
- 不修改业务语义。

### 切片 2：图片同步 SQL 线性化

- 引入 `legacy` CTE。
- 补空 cutoff、已有 legacy、多个 legacy 记录和结果等价的回归。
- 在同一数据集上比较执行时间和查询计划。

### 切片 3：只读通道隔离

- 装配 `backgroundReads`。
- 收窄图片同步协调器依赖。
- 让记忆管理读路径走隔离 reader，写路径保留主 worker。
- 增加生命周期关闭、lease 失效和延迟结果拒绝测试。

### 切片 4：候选准备集成

- 使用合成 SQLite 和合成 provider 跑完整候选链路。
- 记录“受理 → 上下文冻结 → 运行时可用 → provider 收到请求”各段。
- 若仍超过目标，再按实际测量决定是否合并图片同步 pending 查询。

### 切片 5：开发 App 验收

- 复用 `pnpm run dev` 和现有热更新实例。
- 只使用合成联系人、合成输入和明确的测试对象。
- 对比修复前后准备阶段；报告实际命令、样本量、数据影响、剩余风险。
- 不打包、不推送、不执行外部消息发送。

## 风险与取舍

- **SQL 语义风险**：legacy cutoff 是权限和退避语义的一部分，必须用结果等价测试和边界夹具覆盖，不能只以耗时下降作为成功标准。
- **只读快照风险**：独立 reader 扩展了读取并发，但必须继续通过既有 lease、前后范围核验和删除排空；不能把读隔离当成一致性豁免。
- **测试脆弱性**：CI 不把单一墙钟阈值当作唯一证据；性能指标同时记录查询计划、结果数量和真实样本量。
- **优化范围蔓延**：Skill 两次调用、50 条窗口和旧讨论隔离不属于本任务；完成本规格后另行测量再决定是否单独优化。

## 验收标准

- [ ] 大联系人合成夹具的图片同步查询不再出现按消息数 × 尝试数增长的慢扫描。
- [ ] 新旧图片同步结果完全一致，空 legacy cutoff 和已有 legacy 记录均通过。
- [ ] 后台图片或记忆长读进行时，前台候选写入不被其串行队列阻塞。
- [ ] 合成完整链路中，后台读取占用期间候选准备 P95 ≤ 1 秒、最大值 ≤ 2 秒。
- [ ] 记忆管理读取、分页、错误和写入门槛无行为回归。
- [ ] 开发 App 中重复同一热更新实例验证，准备阶段不再出现 30 秒级等待。
- [ ] 报告实际样本量、前后耗时、数据影响、命令结果和剩余风险。
- [ ] 仅提交本任务文件变更，不触碰工作区已有的记忆管理页修改。

## Out of Scope

- 将 DSH 的两轮模型调用改为单轮 Skill 预加载。
- 修改 Skill 目录注入、Skill 选择或模型调用预算。
- 修改最近聊天 50 条上限或移除消息排除能力。
- 改变旧讨论是否进入新候选；该边界按相邻规格处理。
- 自动删除、压缩或摘要旧讨论。
- 外部聊天发送、打包、推送和发布。

## 参考

- [候选回复与助手会话](../../architecture/current/reply-generation.md)
- [存储模块说明](../../backend-ts/src/storage/sqlite/README.md)
- [图片同步动作](../../backend-ts/src/media/sqlite/image-sync-actions.ts)
- [图片同步协调器](../../backend-ts/src/media/sqlite/image-sync.ts)
- [记忆管理服务](../../backend-ts/src/memory/sqlite/management/service.ts)
- [新回复与旧助手讨论隔离](../new-reply-discussion-isolation/spec.md)
