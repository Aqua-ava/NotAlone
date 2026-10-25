# Skill 具名真实双臂 driver

本目录完成 Ticket25 的可执行工程接缝，不能作为正式模型质量、完整后台调度、App 或微信验收通过。只写本目录，未修改生产源码、冻结材料、oracle、primary.json、三个既有人类测试、Git index 或提交。

源码固定旧 `3c168296e9e8edaa43b8b323ff693e790e709069`、新 `e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。与起始 `9b20e99c771d87986579f4343c68bb743afe2bc4` 比较，运行材料中的 `backend-ts/src/reply-comparison.ts` 有已知16行变化；Skill/ModelHost/来源及迁移链逐文件相同。`source-binding-manifest.json` 绑定实际 archive、独占 driver 和冻结 broker 的903个文件。SDK版本与实际entry SHA见最终summary，运行前后相同。

`index.mjs` 导出 `createSkillBusiness`，并复用冻结 `FormalExecutor`、`prepareFormalPlan`、`timeQualification` 与 `bindExistingProblemBudget`。根须提供真实的 source、permission、同问题持久budget和supplier。实际业务模块应从固定 archive 目录导入，不能从漂移工作区导入后自报提交。`snapshot.mjs` 与 `probe-worker.mjs` 演示该接线；公开 CLI 仅支持明确的 `--synthetic-only`。

新臂经官方具名profile、真实 `startModelHost`、PG accounting，调用导出的生产 `SkillLearningTaskRunner`、`SkillLearningRuntime` 与 `createHostReplyRuntime.callExtraction`。授权、公开读取／关闭和审核拒绝复用 `handleSkillLearning`。旧臂在独立Python子进程运行冻结 `PostgresSkillLearningStore.capture/validate/save` 与 `LangChainSkillProposalRuntime.propose`，不构造业务草稿替代真实执行。旧公开入口没有ModelHost，此差异如实保留；两臂物理发送都受外层持久broker管理。

为保持本次SDK及业务重试均为0，采用一次 `propose_skill` runner，以及成功后一次无模型的 `verify_skill_drafts`。没有启动自动后台Worker，也没有改变它默认最多三次claim的合同；该默认路径未被本证据认证。503时仍余998，统一执行结束余992，没有用余额耗尽阻断重试。新入口及PG准备为Node；原冻结材料导出是独立离线Python准备，旧业务Python只在私有夹具中运行。

最终统一运行：[probe-mltosA-summary.json](probe-mltosA-summary.json)，命令与原始stdout/public SHA见 [verification-iZTZtI.json](verification-iZTZtI.json)。同一完整1056计划、同一持久合成账本执行4个pair，共8次实际localhost HTTP、8次reserve、8条PG台账。

| 探针 | 两臂实际结果 | 持久证据 |
| --- | --- | --- |
| 冻结明确纠错 `skill_learning-12` | 成功2；非空提案由真实SDK解析和业务保存 | pending/revision1各1；目标v1与s4/原消息依赖绑定；启用v1不变，发布0 |
| 503 `skill_learning-01` | 失败2；每臂1 HTTP，0重试 | PG各1条run_failed；草稿0；broker.failed=2 |
| 持久取消 `skill_learning-11` | 取消2；关闭授权后才返回冻结late文本的完整非空工具响应 | PG仍各记1；任务cancelled；新草稿0；broker.responded=2 |
| 缺少终态标记 | unknown2；完整工具JSON不能替代协议终态 | PG失败各1；草稿0；broker.unknown=2；原executor/business状态另留 |

成功pair取得实际业务接纳、claim、SDK stream、Store.save事务与返回边界；首事件、首token来自SDK观察，未用供应商写出时间补造。失败／取消没有持久结果时保持null；旧取消可观察到失败的save调用，不代表提交成功。完整报告不计算正式延迟优劣。

实际请求记录 `deepseek-flash`、temperature 0、thinking disabled、输出393216；旧top_p=1，新省略，均如实记录。输出容量与费用不作门槛。用量是合成供应商经实际SDK/PG返回的24/17，费用unknown；响应模型为 `synthetic-loopback`，不是实际DeepSeek质量或账单证明。

每次发送前独立重取PG owner/contact、活动来源/文本SHA、原消息作者与观察时间、输入依赖、Skill版本／库修订、授权、worker与租约；最终运行每条记录实际复核6次。现有来源、目标v1及人工审核边界不由模型决定。新臂附加无comparison的公开approve请求实测HTTP500/internal_error，草稿仍pending1、启用v1未变化。该错误分类不是4xx合同通过，根已另起独立修复；旧证据不改写。

时间资格见 [clock-evidence.json](clock-evidence.json)：两臂公开学习capture/propose没有 `as_of` 或clock参数。保留冻结输入观察截点 `2026-10-23T12:00:00+08:00`、来源10月20/21观察时间，实际SDK/PG时间在最终summary单列；不改Date、PG now或租约时钟。`24 hours` 是来源消息与turn的相对窗口，不是实验clock。正式preflight因缺少时间／独立语义资格而失败。

四个相关集成测试实际4/4通过。所有工程尝试见 [probe-history.json](probe-history.json)：35次HTTP与35次持久reserve，保留早期依赖失败、首个旧适配ready缺字段、审核5xx断言失败，以及首次统一8次执行的收尾失败，不能只保留最终成功轮。首次统一运行的一个旧取消夹具立即检查见1连接；精确停止已完成的自有worker后，按冻结case11的scope/source SHA/取消任务核验、确认0连接，再正常drop。原失败报告和补充清理回执保留；夹具现使用一次最多1.5秒的有界等待，不强杀未知PG会话。

最终8个合成库均删除、连接为0；固定源码snapshot 44,604KiB→0，自有引用进程0。原始HTTP、PG/ModelHost、事件、账本和失败日志留在仓库外0700/0600；公开仅脱敏数据与raw/public SHA。不读取真实联系人、既有账本、项目.env或密钥，不启动App/微信、不访问真实供应商模型、不发外部消息、不打包、不提交或推送。日常开发仍仅 `npm run dev`，此任务未启动它。

最小复现使用现有Node24、依赖与本机合成PG权限，按工程环境加入PATH：

```sh
node --test .scratch/dsh-ts-migration/nonreply-skill-formal-driver/driver.test.mjs
node .scratch/dsh-ts-migration/nonreply-skill-formal-driver/verify.mjs
```

未执行完整1152/120/96、独立盲审或真实模型质量；统一分母仍为1056非回复/1152总计，当前8个observed、1048个nonreply not_run、96个reply未跑。25/26不批准。

官方API核验依据：固定DSH [profile启动](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md) 与 [LLM prepareCall/stream](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md)；旧SDK按实际安装的 [langchain-core 1.5.5 callbacks](https://github.com/langchain-ai/langchain/blob/langchain-core%3D%3D1.5.5/libs/core/langchain_core/callbacks/base.py) 和 [langchain-deepseek 1.1.0](https://github.com/langchain-ai/langchain/blob/langchain-deepseek%3D%3D1.1.0/libs/partners/deepseek/langchain_deepseek/chat_models.py) 复核。文档只证明接口约定；实际执行以本目录证据为准。
