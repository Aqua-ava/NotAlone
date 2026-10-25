# L2 / L3 具名真实业务 driver

`business.mjs` 导出 `createL2ScenarioBusiness`、`createL3ProfileBusiness` 及路由装配 `createLayeredBusiness`。三者提供冻结 `FormalExecutor` 所需的 `business.open(run)`。这是 localhost 工程执行路径，正式质量资格保持未定。

旧臂使用 `3c168296e9e8edaa43b8b323ff693e790e709069` 的 `LayeredMemoryService.organize`、公开任务领取和 `run_batch`。官方 LangChain / DeepSeek SDK、文档工具、提案、独立来源核验及发布事务全部实际执行。仅跨进程许可客户端来自最终新 pin，通过旧服务公开 `model_priority` 参数接入真实 `startModelHost`；旧业务模块没有混用新源码。

新臂使用 `e60074b5946b8d1c990fcb75ba13bd58f789b2fb` 的官方 DSH profile、`createLayeredMemoryManagement` 刷新、`ExtractionTaskStore.claim` 和生产 `createL2ScenarioHttp.handlePrivate`，执行 `createL2ScenarioHost` 的完整业务。ModelHost、PG accounting、来源校验器、文档工作区及独立核验均为生产实现。未经过完整 `createHostReplyRuntime` / App / 微信，不能用本探针认证这些集成。

两域共享生产 L2→L3 维护管线；具名域决定应检查的业务输出。L2 以非空场景验收，L3 以非空画像验收。来源回显供应商仅机械复用实际请求的来源与版本，不读取 oracle、不独立判断语义。其结构化核验响应只检验合同，不能作为质量评分。

## 根注入

```js
const named = createLayeredBusiness({
  snapshot, directory: privateDirectory, contexts, receipts,
  evaluationClock: {mode: 'wall', qualification: 'engineering_only'},
});
let active;
const business = {async open(run) {
  active = await named.open(run);
  return active;
}};
const broker = await createPersistentBroker({
  directory: privateJournalDirectory,
  budget: existingRootProblemBudgetPort,
  source: {assertCurrent: () => snapshot.assertCurrent()},
  permission: rootPermission,
  assertCurrent: () => active.assertCurrent(),
  controls: {
    model: 'deepseek-flash', maxTokens: 393216,
    temperature: 0, thinking: 'disabled',
  },
  transport: explicitlyAuthorizedTransport,
});
const executor = new FormalExecutor({
  plan, business, source, permission: rootPermission,
  budget: broker.budget, supplier: broker.supplier,
});
const report = broker.reconcileExecutorReport(
  await executor.executePair(runIds, {qualityMode: 'engineering', signal}),
);
```

根总账只能由 `problem-budget-port.mjs` 的既有绑定传入；driver 不建立、读取或重置真实问题账本。正式模式还须由根提供有来源的时间与独立语义资格回执，driver 不生成此回执。仓库 CLI 固定使用新的合成 SQLite 账本与 loopback 传输，没有真实供应商开关。

`open` 在返回前完成实际建库、公开刷新／入队和租约领取；`assertCurrent` 复验真实 PG 来源快照、范围设置、worker、租约代次与真实过期时刻。`run` 接受唯一的外层 broker dispatch。内层没有问题总账绑定，SDK 与业务重试均为 0；模型文档工具的后续成功回合仍逐次记账。

`session.cancel()` 调用旧公开 `command(disable)` 或新公开 `/layered-memory/disable`，随后由生产来源／世代／租约 fence 拒绝迟到写入。冻结取消事件默认在首个真实物理响应收到后、交给 SDK 前持久取消。合成取消探针更早在供应商响应前提交取消，再实际返回冻结迟到写入正文。

## 时间、持久计数与未定项

冻结材料的 `observed_at` 是来源观察截点，`as_of` 是评测截点；均不证明事件实际发生。原文、版本和这些值原样保留，fixture 的保存时刻使用真实 PG 默认值。没有伪造全局 `Date` 或 PG `now()` / `clock_timestamp()`。

`evaluationClock.mode='wall'` 使用真实壁钟，只具工程资格。`frozen_content` 显式采用 `input.as_of`，但当前 L3 把内容时钟复用于生成内部租约，新 accounting 又使用真实 PG 时钟检查它；过去截点会被正确拒绝。不能把改成壁钟视作冻结时间资格通过。精确待接线点见 `time-qualification.json`。

旧原入口的持久 `layered_memory_job.model_calls_used` 记录请求预约，原普通整理 transport 没有新增版出站台账／ModelHost 会计回执。成功、503、实际迟到取消路径中该计数与 HTTP 相等；发送前被根拒绝时它可能已加 1，不能冒充物理发送。新臂也保留发送前 PG 预约。此时冻结执行器会报告计数不匹配；broker 的持久物理记录、未发送证明及 unknown 一并保留，不能退款或补造成功。

旧冻结个人整理的实际 `max_tokens=8192`；新实际配置 `393216`。两者均按请求记录，不以输出容量差异阻塞执行。费用为 unknown，供应商用量是 localhost 夹具声明值。来源、授权、模型、温度、thinking、取消、失败与完整分母门禁继续。

`five_phase_evidence.complete=false`：有业务进入、broker 派发／返回和最终 PG 读取时间，缺原公共入口的完整准备阶段、首 token 及无重叠五阶段，不能认证正式 p50/p95。

## 最小复跑

在可用 Node 24、Conda NotAlone Python、锁定 `backend-ts/node_modules` 和本机 PG 下执行；不启动 App，不打包。

```sh
node --test .scratch/dsh-ts-migration/nonreply-layered-formal-drivers/drivers.test.mjs
node backend-ts/node_modules/typescript/bin/tsc -p .scratch/dsh-ts-migration/nonreply-layered-formal-drivers/tsconfig.json
node .scratch/dsh-ts-migration/nonreply-layered-formal-drivers/probe.mjs --synthetic-only all
node .scratch/dsh-ts-migration/nonreply-layered-formal-drivers/probe.mjs --synthetic-only guards
```

`all` 固定两域各一个成功、503 与取消双臂，共 12 个工程运行；`guards` 固定两域×双臂×权限／来源／租约，共 12 次守卫探针。CLI 不支持完整 1056/1152、120 资格或 96 回复矩阵。

已实际覆盖冻结 `-01`、`-03`、`-05`、`-11` 的指定用途；删除态、跨范围、错误主体、纠错等剩余完整材料没有签收。缺少真实入队／租约时 driver 直接失败，不为满足冻结执行器的 task/lease 合同伪造空任务。根接完整矩阵时需明确合法无任务 idle 与失败的区分，并保留所有未执行及适配未定项。

`clock-probe.mjs --synthetic-only expired <e600完整pin>` 读取真实 PG 租约，复现已保留的过去截点失败。根提交时钟修复后可用 `--synthetic-only live <新完整pin>` 执行一对固定过去截点的最小双臂；此命令不认证旧内部租约或语义质量。

原始 HTTP、PG、profile、ModelHost journal、预算与失败留在独立 0700 / 0600 端侧目录。公开摘要用范围摘要替代联系人身份；`probe-history.json` 保留每轮原始／公开 SHA，失败探针没有删除或并入质量通过率。`artifact-manifest.json` 与 `handoff.md` 是本目录最终交付入口。
