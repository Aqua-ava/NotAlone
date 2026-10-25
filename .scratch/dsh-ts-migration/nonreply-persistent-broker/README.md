# 非回复持久供应商 broker

本目录是 Ticket25 的独立工程接缝，不接入产品运行时。生产源码固定为 `e60074b5946b8d1c990fcb75ba13bd58f789b2fb`，旧臂为 `3c168296e9e8edaa43b8b323ff693e790e709069`。`9b20e99→e60074b` 唯一生产差异是评测报告器的显式费用豁免，diff SHA 为 `33c689b375b3b8559edfdb77a2d22461cebebaf2bb46deac19331092103b3bcb`；发送、ModelHost 和业务链路无差异。冻结 seam、材料、oracle、primary、三个既有人类测试均未改。

入口为 `broker.mjs` 的 `createPersistentBroker`，返回 `budget`、`supplier`、`journal`、`summary()`、`reconcileExecutorReport()` 和 `close()`。运行时四文件 SHA 见 `manifest.json`。`verify.mjs --synthetic-only` 是唯一验证 CLI，没有读取凭据、创建真实问题账本或真实发送的 CLI 开关。

## 根启动契约

根在内存中提供：已绑定的同问题持久预算端口、固定源码端口、权限端口、来源／范围／租约复核、模型控制、私有 journal 目录及凭据解析器。根目录必须已存在且属于当前用户、权限0700，SQLite 和锁文件使用0600。不读取项目 `.env`、真实联系人或原累计账本；合成 HostStorage 只消费本轮临时配置。

```js
import assert from 'node:assert/strict';
import {FormalExecutor} from '../nonreply-formal-model-seam/formal-executor.mjs';
import {bindExistingProblemBudget} from '../nonreply-formal-model-seam/problem-budget-port.mjs';
import {createPersistentBroker} from './broker.mjs';

const existing = await bindExistingProblemBudget({
  configuration: rootBudgetConfiguration,
  expected: rootExpectedBudgetConfiguration,
});
const sessions = new Map();
const business = {async open(run) {
  const session = await namedDriver.open(run);
  sessions.set(run.run_id, {session, original: await session.assertCurrent()});
  return session;
}};
const broker = await createPersistentBroker({
  directory: rootPrivateJournalDirectory,
  budget: existing,
  source: rootSourceSnapshot,
  permission: rootPermission,
  async assertCurrent(binding) {
    const entry = sessions.get(binding.run_id);
    assert.ok(entry);
    assert.deepEqual(await entry.session.assertCurrent(), entry.original);
  },
  controls: {model:'deepseek-flash', temperature:0,
    thinking:'disabled', maxTokens:393216},
  resolveCredential: rootCredentialResolver,
});
try {
  const executor = new FormalExecutor({plan:rootFrozenPlan,
    source:rootSourceSnapshot, permission:rootPermission,
    business, budget:broker.budget, supplier:broker.supplier,
    qualification:rootQualification});
  const original = await executor.executePair(rootPairIds, {
    signal:rootAbortController.signal, qualityMode:rootQualityMode,
  });
  const report = broker.reconcileExecutorReport(original);
  const accounting = await broker.summary();
  await rootPersistPrivateEvidence({original, report, accounting,
    journal:broker.journal.events()});
} finally {
  // 必须先停止业务、取消并等在途execute/send结算，再关闭journal。
  await broker.close();
}
```

上例中所有 `root*` 和 `namedDriver` 都必须由根明确注入。`source.assertCurrent()` 返回稳定顺序的 `{candidate_commit,old_commit,source_sha256}`，并实际验证 archive、接缝及依赖字节；单个来源哈希不能替代复验。`assertCurrent(binding)` 从服务端复核 owner/contact、来源当前状态、任务身份和租约世代。权限端口核对计划、问题、接收方和用途，不能信任请求正文自报。根不把旧 receipt 恢复成发送权。

真实默认 transport 仅接受 `resolveCredential({route,endpoint})` 在内存中返回的 key；不读环境变量，不复制调用方 headers，不传递临时 DSH 会话标识。合成路径显式传 `createLoopbackTransport({origin:'http://127.0.0.1:端口'})`，固定路径、无凭据、无外网。根注入端口属于可信边界，不是针对恶意根代码的网络沙箱。

`createSyntheticBudget({directory,limit:1000,deadline})` 返回 `{port,read,close}`；只新建带 `synthetic-` 问题名的文件，拒绝覆盖已有文件。它供机械测试使用，不能替代原真实累计账本。业务内层仍有 PG、ModelHost、许可及调用台账，`inner_problem_budget_bound` 必须为 false。

## 三种核验后的协议

| route | 本机实际入口 | 唯一官方目标 | 实际来源 |
| --- | --- | --- | --- |
| `messages` | `/anthropic/v1/messages` | `https://api.deepseek.com/anthropic/v1/messages` | 已安装 DSH `DeepSeekAdapter` 的 Messages 序列化和官方 profile |
| `strict_chat` | `/beta/chat/completions` | `https://api.deepseek.com/beta/chat/completions` | 生产 `beginStrictVerificationCall`、`buildDeepSeekStrictVerificationRequest` 与非流式 fetch |
| `chat` | `/v1/chat/completions` | `https://api.deepseek.com/chat/completions` | 固定旧 Python `build_deepseek_model`／实际 OpenAI SDK |

主协调在本任务中明确追加了旧臂第三种协议；不能把旧 Chat Completions 冒充 Messages 或 Beta。冻结 reply 透传的 `/python/chat/completions` 仅为旧 chat 的另一已核验本机前缀，目标相同；本次非回复 SDK 实测使用 `/v1/chat/completions`。不接受任意 URL、query、path 或请求指定接收方。

准确性依据为本机安装的 DSH `0.2.1-rc.2`（已知固定源码 commit `687f282e8625c6b8d11ff58211a90524be2e4317`），生产固定源码和 localhost 实际 raw SHA；Python SDK 版本与入口 SHA 见最终 probe。官方一手文档：[Anthropic 根地址](https://api-docs.deepseek.com/)、[Beta strict 及 schema 要求](https://api-docs.deepseek.com/guides/tool_calls/)。在线 Anthropic 专页读取超时；未用网页状态代替本机源码和实际协议证据。当前 strict 是生产专用 transport，不声称 DSH adapter 原生提供 strict Beta。

不改写 raw。JSON 仅用于校验，发送仍使用原 UTF-8 字节。输出 `393216`、旧臂省略 `max_tokens` 或其他实际值全部记录，输出差异和费用 unknown 均不设门槛。模型、temperature、thinking、top_p、协议及来源门禁保留。无业务重试、SDK重试、transport重试或重定向；HTTP503 在充足剩余额度下实测只发送一次。

## 持久状态与恢复

`ready → reserved → dispatching → responded / failed / unknown` 逐次 FULL synchronous SQLite 提交，事件有顺序和 SHA 链，最终行与事件摘要相互验证。`reserve_requested` 在调用外层账本前持久记录；账本已扣但 receipt 丢失时保持 unknown，不退款。ACK 只确认，实际冻结端口连续 ACK 两次仍只 reserve 一次。

`supplier.validate` 建立 ready；唯一 reserve 在传给 FormalExecutor 的 `broker.budget.reserve`。发送前复验源码、权限、服务端来源／租约、取消、实际 raw SHA 和新 ACK；capability 绑定 attempt 和请求。dispatching 提交后才构造 socket 并写原字节。同 reservation 不能二发，同 attempt 的并发 reserve/send 不能释放首个在途占用。

关闭后重开将所有非终态保守记为 unknown，物理状态为 null；保留原 reservation、状态和事件。进程崩溃遗留的锁必须由根的 `recoverStaleLock(prior)` 确认旧持有者已停止，随后仍检查 PID 未存活；没有自动抢锁。未知 run 不接受换 attempt ID 或换正文重放，也没有自动恢复／解锁／重发 API。新进程保留最初 used 基线；绝不把当前 used 当作重置额度。若 reserve 或响应仍不确定，根保留证据，不根据“无响应”推断未发送。

`responded` 只表示协议终态完整，业务仍可失败或被取消；PG 和业务状态保持独立。冻结旧提取脚本在 `failed_batches:1` 时可能报告 succeeded；`reconcileExecutorReport` 保存 `reported_terminal_status`，并用持久 failed/unknown 降级结果。原始报告必须一起保存，不覆盖历史事实。

## 验证与边界

最小命令（根提供可用 Node24 的 `BROKER_NODE`，不在公共文件写本机绝对路径）：

```sh
"$BROKER_NODE" --test .scratch/dsh-ts-migration/nonreply-persistent-broker/journal.test.mjs .scratch/dsh-ts-migration/nonreply-persistent-broker/broker.test.mjs
"$BROKER_NODE" .scratch/dsh-ts-migration/nonreply-persistent-broker/verify.mjs --synthetic-only
```

最终验证13项通过，留存11个 broker 用例的原始 SQLite、合成预算与 wire。实际进程退出后从 dispatching 恢复 unknown；失去 ACK、失去终态、并发、取消、来源、授权、租约、raw SHA 变化均有证据。成功 SDK 对为4次 HTTP、4次外层 reserve、4个物理 journal、两臂 PG 各2；503 对为2次 HTTP、2次 reserve、2个 failed journal、两臂 PG 各1，剩余998。实际请求 raw SHA 在 SDK 入口、broker 和供应商 localhost 接收端相等。失败历史保留，见 manifest 的全部 probe 列表。

transport 采集写入、headers、首字节、可见 SSE 事件／模型 delta 和结束时刻；非流式首 token 为空。它没有观测完整业务准备和最终持久化阶段，五阶段资格仍为 incomplete，不据这些时间推断正式延迟通过。完整非回复1056／统一1152分母保留，最小 pair 只改变 not_run。正式语义、来源时间资格、120人类时间资格、盲审和真实供应商质量均未确认。

没有启动 App／微信、打包、外部聊天发送或真实供应商调用。原始日志在仓库外0700/0600目录，公共副本不含本机路径、联系人或会话标识；每次 probe 及最终验证都有 raw/public SHA。正常运行创建的合成 PG、profile、socket 和源码 archive 已清理。首轮缺 USER 导致创建后未返回的四个空合成库，已按精确夹具／错误时间与内容归属复核，确认无业务行和其他连接后清理，证据见 `failed-fixture-cleanup.json`。Git index／commit 留给主协调。

本次按 `code-review` 的 Standards／Spec 维度串行复核；用户明确禁止再委派，所以没有运行技能要求的并行独立子 Agent，不宣称独立审查完成。主协调仍应独立审核最终运行时 SHA。
