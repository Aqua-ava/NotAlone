# 真实 ECNU 回复估算预算接入

State: claimed
Triage: ready-for-agent

## 范围与接缝

按[已确认规格](../spec.md)与[ADR-045](../../../architecture/adr/045-explicit-estimated-ecnu-input-budget.md)，在既有公开 App→HTTP→隔离数据库接缝修正预算类型、生产模型装配、保存恢复及显示；外部模型边界替换为受控合成适配器，生产 SDK 请求只在自有离线传输中观察。主 Agent 负责原库与有限真实 App，子 Agent 不读取私人资料或运行 App。

## 验收条件

- [x] 已核实 ECNU 配置的短请求允许生成并返回、保存、恢复明确估算回执。
- [x] 完整输入、输出上限与正数安全余量逐轮检查；超长、未知或错配零模型调用。
- [x] `ready` 也显示估算，新旧回执严格兼容，实际超长失败保留历史且不泄露正文。
- [x] 不摘要、截断或无限重试，不新增 DDL，不扩大资料范围。
- [x] 最小相关测试、两轴评审、本地提交与 main 集成完成。
- [ ] 主 Agent 完成已授权原库升级并打开20分钟真实 App；真实调用与体验结果单独如实记录。

## Comments

2026-10-12：在集成后的 main 基点 `3b74fd1b` 创建独立工作树，保护其他并发记忆文档改动。数据库038→055的私密恢复升级演练已通过；原库保持038，待本票验证后升级。外部模型请求与真实 App 启动目前均为0。

## 接入验证（2026-10-12）

- 后端预算／runtime／middleware／actual SDK定向66项通过；公开生产ECNU、旧预算、真实SDK限长与业务流最终19项通过（30.288秒）。随机合成库执行正式001–055，重复0，清理残留0。初次协调命令误写两个测试模块名造成import失败，修正模块名后上述19项全部通过；原失败保留。
- 桌面生产 Main/preload→HTTP→隔离PG→React定向13项及旧exact接缝1项通过；保存后重新装配服务、公开选择历史重读回执，模型边界调用保持1。默认安全测试46项、类型检查和构建通过，均未启动App。
- red→green覆盖生产短请求由409不可用变为200估算、后续tool再检、长输入零调用、typed receipt恶意余量、真实SDK 400稳定code到409独立错误、生成／继续／探索提示与禁重试、正常估算可见及服务重建重读。
- Standards轴：硬性违规0，可选Duplicated Code 1（四个HTTP入口一致的固定错误响应，当前不阻塞）；Spec轴：发现0。独立评审均未读取私人配置或运行App／模型。
- 原库升级前再次只读核对备份SHA、完整原结构／资料哈希、036–038账本、baseline与任务／连接，全部与私有恢复演练一致；原库此刻仍038。

实际命令：

```bash
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
# backend/ 中按 tests.unit.reply 的 budget/runtime/exploration/middleware/receipt/ecnu 模块运行 unittest
python /private/tmp/notalone-coordinator-isolated-tests.py <本票工作树> \
  tests.integration.server.test_ecnu_input_budget \
  tests.integration.server.test_provider_context_limit \
  tests.integration.server.test_assistant_input_budget \
  tests.integration.server.test_core_business_flow
# desktop/
PGPORT=55441 NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false node --test --test-reporter=spec \
  tests/assistant-provider-context-public.test.mjs tests/assistant-input-budget-approximate-public.test.mjs \
  tests/assistant-input-budget-read.test.mjs tests/assistant-input-budget-notice.test.mjs
PGPORT=55441 NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false node --test --test-reporter=spec --test-name-pattern='真实预算拒绝后复验GET的connection' tests/assistant-input-budget-public.test.mjs
npm test
npm run build
```

## main与原库升级收据（2026-10-12）

修正提交56725d35合入main的d962f7b2，保留其他并发任务变更。main上公开ECNU／provider限长／业务流8项复验通过（9.896秒），随机合成库正式55迁移、重复0且清理0；main构建的6个dist文件与新签名包ASAR逐字节一致。

主Agent沿用户明确授权，在本机私密备份与038→055完整恢复演练之后再次核对备份SHA、源结构和全部原资料一致且无其他源连接／未完成任务，然后标准migrate执行039–055。原业务表原列摘要、旧036–038记录含时间、035接管baseline保持一致；完整账本到055匹配本机main，startup readiness为ready，重复migrate应用0。私密备份及原库升级收据保留在仓库之外、0700目录／0600文件，不提交任何私人行、凭据或身份。真实App随后执行，不能据数据库就绪宣称模型质量已验收。
