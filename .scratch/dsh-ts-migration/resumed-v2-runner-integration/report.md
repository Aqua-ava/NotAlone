# 固定96 runner接入生产v2来源采集

2026-10-25；实现及最终本机fake验证完成。最终显式pin为 `263365556e9058b3fc7b1abbbdbe43b7f9a323d2`；6/6通过（52.3秒），交根独立复审与统一提交。没有调用真实模型、创建预算、操作App／微信、Git暂存／提交或远端操作。已接收用户暂豁免费用门槛的范围更新，不为费用启动真实96。

## 已交付

- 将实际运行过固定96的 `/tmp/notalone-ticket25-alias-v1/runner.mjs` 及必要支持收敛到 `ticket25-final-run/`，新增统一 `run-full.mjs`；旧私有runner及历史采集未改写。公开合成副本的变化与哈希列于 `files.json`。
- `runner.mjs` 从固定候选源码动态导入生产 `captureReplyRuntimeSourceAttempt`；完成后实读PG sources、request、candidates，生成v2 catalog及独立mapping，不再手写alias适配。`replyComparisonCollectorBinding`绑定实际提交、源码树、工作树与argv摘要。
- 保持16例×3重复×双臂、AB／BA顺序、同模型参数、无自动重试、完整物理请求数／usage／五阶段。正式入口只消费已有问题总账，需完整40位提交与相同提交的私有配置；原始输出强制在仓库外新建0700目录，文件0600。
- 旧臂仍执行固定 `3c168296` Python业务与SDK；保存原源码文件摘要并在执行前后逐项复核，保留旧runner、冻结输入ID、SDK流式适配与控制参数的独立profile摘要。不从新臂或候选反推旧输入。
- 微秒到毫秒的转换只发生在采集时钟边界：保留 `raw_wall_started_at`、原值SHA、转换说明；不改旧材料、PG来源或单调时钟观测。
- normalizer核对新／旧来源、实际wire和PG，再计算实际prompt／tools及双臂profile哈希；指定新提交时缺失v2证据直接拒绝。历史旧采集保持原有未知，不补造旧hash。
- 本机fake入口不读预算／凭据，不连接外网；输出强制 `reporter_fixture`，伪评审数据仅用于格式验证，始终 `real_model_quality_verified=false`、`production_switch_approved=false`。
- 失败和取消保留全96分母及真实物理请求，未知usage／cost保留null。盲包只接受完整成功配对，来源不完整、mapping缺失或篡改、wire变更明确拒绝。

## 验证与RED／GREEN

- 新runner模块在上述最终pin上6/6通过，52.3秒：一对完整业务／PG；正式 `runFixed96` 本机96/96；mapping／wire／旧来源异常拒绝；503；真实业务取消；固定96中94成功＋1失败＋1取消，92项完整配对盲包，报告保留96且不通过。
- 最初RED依次暴露：`vendor_forward_required`、`argument_mode`、取消误标failed、局部故障未生效、null费用使normalizer中止整份报告。对应GREEN与原始日志索引均保留。
- 原生产 `reply-comparison-capture-runtime.test.mjs` 此前从 `backend-ts/` 定向运行1/1通过；最终pin按根要求仅执行上述6例，已包含实际生产DSH＋PG链。此前从仓库根并跑该既有用例失败是相对 `test/observe.mjs` 路径问题，原日志未删除。
- 此前 `backend-ts npm run typecheck`通过；Python支持编译与final-run全部mjs语法通过；`git diff --check`通过。
- `node scripts/check_public_history.mjs --ref HEAD --working-tree` 最终在 `263365556e9058b3fc7b1abbbdbe43b7f9a323d2` 扫描0问题（15,833历史blob、2,364提交、16,805当前文件）。
- 根修改 `reply-evidence-alias.ts`／`reply-payload.ts` 期间，6例全部在源码门禁被拒绝，未运行该轮fake链；拒绝证据保留。根稳定为上述pin后已完成最终6/6复验。

最小复验（仓库根；源文件须干净，HEAD须与显式pin一致）：

```sh
PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH" \
NOTALONE_COMPARISON_SOURCE_COMMIT=263365556e9058b3fc7b1abbbdbe43b7f9a323d2 \
node --test backend-ts/test/reply-comparison-runner-integration.test.mjs
```

原有生产用例在 `backend-ts/` 运行 `node --test test/reply-comparison-capture-runtime.test.mjs`。本切片没有运行共享全量套件。normalizer位于 `.scratch/ticket25-final-run/`，不在生产源码脏门禁检查路径内，不需要绕过门禁或先提交它。

## 数据、来源与剩余项目

- 只使用固定合成16例及独立随机scope的测试PG／临时profile；自有测试库、旧／新源码临时副本、profile和进程由runner清理。没有读取真实联系人、原文或截图，没有发送外部聊天消息。
- 原始日志在 `$HOME/.local/state/notalone/diagnostics/resumed-v2-runner-integration-20261025/`（0700／0600）；仓库只留 `raw-log-index.json` 的逐文件SHA、字节数和精确相对私有路径。没有修改仓库外旧runner。
- DSH锁定 `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`；核对 `/tmp/deepseek-harness-687f282/` 的 Agent README、LLM `prepareCall` README、DeepSeek adapter源码及sdk-minimal配置，复用现有官方profile／host支持，不新增DSH私有接口或修改核心。
- 待根独立复审与统一提交；真实质量、双盲／第三裁决、正式时延与App／微信／记忆验收由根统一调度，本切片不认证这些资格。
- 单attempt来源完整通过；非窄合同的多attempt仍按生产审计拒绝或未定，不绕过门禁。未把哈希内部一致性宣称为远端真实性。

根整合有一后处理: runner EOF whitespace only; semantic code unchanged.
