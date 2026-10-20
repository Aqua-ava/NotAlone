# 02：依据原话解析日期并保留精度

Triage: ready-for-agent
State: resolved
Type: task

Blocked by: 01

交付：不同消息的昨天／明天分别以各自来源解释；年、月、日和具体时刻如实展示，模糊表达及缺时区保持未知。事件阶段与事实适用期分离，无来源的默认起止日期不再产生。

验收：正式提取／独立核验 → 持久资料 → API／页面 → 分层引用及生成快照；跨时区、去年、上月、多锚点、午夜、未知、计划到期均有合成用例。新事件合同兼容旧版本，时间元数据跟随来源删除。同步旧提示与规格的默认期限口径。

## Acceptance criteria

- [x] 本票上述完整行为已从正式流程传递到 API、页面、分层资料及回复冻结／恢复依据。
- [x] 新旧合同兼容、来源删除、联系人／本人隔离和未知语义有合成回归。
- [x] 沿已确认公开测试边界完成单例 red → green、相关回归和类型检查。
- [x] 记录真实命令、结果、数据影响与未验范围，未将脚本模型通过冒充真实模型质量。

## 执行约束

规格见 [spec](../spec.md)，实现入口见 [exploration](../exploration.md)，依赖见 [拆分](../ticket-proposal.md)。工作流、工程、领域与本地任务规范按仓库入口读取。仅修改本票文件，适配同时进行的任务。桌面仅使用 npm run dev，先核对并复用开发实例，禁止打包。没有授权进行真实存量重提取、业务数据迁移、远端操作或外部测试消息。测试用隔离合成资料。每个切片 TDD，提交中文本地 commit；基于并合入集成分支，完成后由集成负责人统一评审与验收。

## Answer

已实现来源日历与事件 v2：保留原时间表达、实际消息锚点和年／月／日／具体时刻／未知精度；相对日历以活动来源的原始 ISO 偏移核对，缺日期、缺时区、未核清转述或不支持的表达保持未知。明确绝对日期、常见日历词及有界期间可核对；不构建任意自然语言日期解释器。

正式 direct 提取使用新合同；旧事件 v1、冻结 grounded 协议和旧完成回复保持兼容。无来源的瞬时期限清为空；本周等已知完整日历期间核对后保留，其他明确数字期间仍经独立语义核验。API、联系人／本人资料、L2/L3 引用、回复输入及冻结恢复保留精度；页面不将年／月边界显示成精确发生时刻，多单位期间完整显示，来源日期明确显示偏移。

093 只扩展数据库事件 JSON CHECK，不改写旧资料，依赖票03的092。新授权观察批次允许无消息日期的精确处理目标并记录完成回执；旧 CLI、旧观察升级水位范围不扩大。无日期目标完成回执后保留原有时间水位，不使旧路径意外从头扫描。现有 vendor JSONL 仍要求完整一致的时间身份，缺日期继续拒绝，不宣称支持无日期 JSONL 导入。

实际验证（合成资料、隔离 PostgreSQL，外部模型只替换边界）：
- 首个 Flow 年历精度、HTTP 持久化、组件读取及无日期观察目标均先出现可定位失败，再实现通过。
- `python -m unittest discover -s tests/unit/memory_extraction -t .`：996 个通过，180 秒有界运行。
- `python -m unittest tests.integration.server.test_memory_date_precision`：4 个通过，包含错误日期被外部核验放行仍降为未知、两条不同原时区“明天”、年／月精度、本人 L2/L3、冻结恢复与来源删除。
- `python -m unittest tests.integration.server.test_observation_auto_flow tests.integration.server.test_memory_processing_guards tests.integration.server.test_memory_processing_progress tests.integration.server.test_memory_temporal_evidence tests.integration.server.test_memory_current_status`：52 个通过。
- 水位保护补充验证：command 单元 29 个通过，观察／进度／新日期集成 28 个通过，新增错误日期 HTTP 单例通过。
- 桌面日期精度、时间状态、事件与恢复依据相关测试：34 个通过；`npm run typecheck` 通过。恢复依据浏览器测试首次缺 Playwright 缓存，改用已安装 Chrome 后通过，无新下载。

未运行实际 App、微信或真实模型质量评测，由集成负责人统一验收；没有重提取真实存量、运行业务迁移、打包或远端操作。

## Comments

2026-10-20 用户明确同意四票拆分及测试范围，发布为 ready-for-agent。
