# 03：在 App 查看全过程并接通所有默认提取入口

Triage: ready-for-agent
State: claimed
Blocked by: 01, 02

## What to build

用户在 App 从关系记忆或待确认候选查看完整提取过程，也能查看没有保存记忆的批次、失败与重试。所有实际执行的提取入口默认记录；用户可以手动删除追踪，旧资料显示真实缺口，来源删除后不再恢复正文。

## Acceptance criteria

- [x] App 提供受授权的批次列表、详情与候选/记忆反查，展示每步实际输入输出、规则、状态和关联。
- [x] 手动删除追踪不误删权威记忆，已删/未记录/手动资料不适用与失败状态区分，刷新不会跨联系人显示。
- [x] 历史任务、后台增量、CLI 和人工触发全部生产装配默认记录，无静默关闭或绕过。
- [x] 故障、部分写入、零候选、重试与水位一致性贯通到任务状态和 App 展示。
- [x] 全链来源删除、旧记忆依赖、本人归属和跨 owner/contact 隔离集成验证通过，普通日志和最小台账无正文。
- [ ] 运行相关 Python/Swift 验证、完整相关测试与 Standards/Spec 两轴 review，更新实际实现状态并本地提交。

## Comments

2026-10-07：依赖 01 的追踪与 02 的原始来源处理，才能在 App 声称展示新输入的完整链路。不会为展示效果调用真实模型或重提取旧记忆。

2026-10-08：开始交付所有共同后端范围；ADR-039 已退役 Swift 主界面，新 React 界面由后续设计任务处理。本任务 App 验收保持待办，后端实现不修改旧界面或新建前端。

2026-10-08：共同后端范围已完成并通过独立复验。待用户选择本次先交付后端、由新前端接入界面，还是本次补最小 React 查看页；尚未收到该范围问题的答复。依[工作流决策模式](../../../docs/agents/workflow.md)的“功能范围或用户意图不明确”，本任务转为 `Triage: needs-info`，保持 `State: claimed` 和 App 验收待办；不静默改写原规格或宣称全规格完成。


## Answer

2026-10-08：共同后端范围已交付。App 查看与刷新验收保持待办，`State: claimed` 不提前改为 resolved；ADR-039 已移除 Swift 主界面，本任务不重建旧界面或新增 React 界面。最终 Standards／Spec 两轴 review 由集成主任务统一执行，本 Answer 不宣称全规格完成。

### 后端能力

- 新 `TraceService` 统一验证已确认的 owner/contact，默认 `create_app` 注入 PostgreSQL 提取与来源处理查询 Adapter；无需构建模型或配置模型凭据。HTTP 支持两类批次列表、详情、反查与手动删除，联系人的列表使用 `limit=1..500` 和 `before=next_before`，按时间＋批次 UUID 稳定继续读取更旧批次；游标范围同样验证。提取追踪提供 message／candidate／contact_memory／owner_memory 查询；来源处理提供 message／source_ref／source_document／local_wechat_observation 查询，两个批次资源保持区分。不存在与越界统一 404，所有追踪类响应（含 401/400/404/500/503 与请求前置错误）no-store，不回显正文、SQL、密钥或凭据。
- `notalone-memory-trace`、`notalone-source-trace` 注册为显式联系人 CLI，提供 list／show／find／delete；show 是用户主动查看完整敏感资料，普通提取／Worker 输出仍无正文。旧资料保留真实 `not_recorded`；手输联系人与 owner 资料 `not_applicable`，从模型候选人工确认的记忆仍能反查原提取批次。手删追踪保留权威记忆，来源处理记录删除清除相关提取复制体，原有正文墓碑与来源／联系人／账户删除边界继续生效。
- `extract_main`、PostgreSQL Runner 与 HTTP 自动／人工原任务默认记录，HTTP 的 priority E/V/A 在 Runner 实际线程中建立 TraceSession；只读查询不调用模型。CLI 增量同步仍只导入来源／消息，本任务没有新增自动提取调度。HTTP 来源处理记录故障安全返回 `source_processing_write_failed`；直接提取 CLI 将独立追踪故障输出为 `trace_write_failed` 和未知提交回执，停止本批而不进入非法模型输出预算。
- 迁移 `042` 增加停止／范围失效／guard 持久故障状态及无正文 `memory_extraction_trace_call`。实际 provider 发送／返回事实先于正文捕获记到调用观察中，正常 E/V/A 与停止／晚返回关联实际台账 ID；收到但未采用的结果显示 `received/returned + not_adopted`。正常台账 I/O 前预留相同 ID，提交回执丢失仅记 `unknown`，不另造 ID 补账。V 已自行写台账后被许可／来源复验丢弃只更新最小关联，不重复记账。删除来源后可以补无正文关联，不能恢复请求／响应／原聊天正文。
- Worker、CLI 汇总、TaskHost 和 SSE 贯通安全 `error_code`。追踪故障与 fail_step 同时写失败时保留 `trace_write_failed + failure_state_commit=unknown`，结束本次执行，不被下一次 idle 覆盖；原任务仍按数据库的真实状态查询，不宣称失败已落库，不退原 attempt。普通既有持久错误、全局锁、三次非法模型输出预算、前台回复优先与共享 4 秒关闭预算保持。

### 公开 red → green 与边界

- 默认回环 HTTP 最初对追踪返回 404，接查询装配后贯通原始行 → 来源处理 → message → 实际窗口 → E/V 输入与原始返回 → 逐候选规则／写入 → 最终记忆反查；从待确认候选人工确认仍保留原批次。只读 HTTP 和 CLI 在模型配置不可用时仍可查询。
- 越界／不存在原先可能作为 `not_recorded` 返回，查询服务依据受范围权威记录区分缺口与不存在；跨 owner、同 owner 其他联系人、详情／反查／删除和分页游标均拒绝。手输 owner 原先错误 404，按实际手输来源显示不适用。列表原先只有最新有界集合，现可通过公开翻页读取到最旧批次及详情，包括无新业务行的批次。
- E 晚返回原先误标 `business_write_failed`，现在标 `stopped/model_work_stopped`；晚 V 原先被标为 consumed，现为 not_adopted；晚 A、来源已实际删除和调用响应捕获故障保留恰一次实际台账与关联，已删事件正文为空。最小关联写入失败不能静默变为成功停止，公开查询显示 `trace_failed/call_receipt`。
- 台账已提交但回执丢失原先对同一次调用写两条台账，真实 SDK 的公开 run_extraction 故障测试改为一条同 ID／unknown；公开 HTTP 的 V 台账回执丢失仍保留一次调用，并通过原任务显式恢复，无重复记忆。追踪响应故障不会推进水位或模型非法输出计数，移除故障后原任务恢复可用。
- 追踪与 fail_step 双故障原先 SSE 报 temporary_failure、Worker CLI 报 idle／退出 0；合成 PostgreSQL 公开故障 Adapter 验证现在保留主追踪错误及未知任务状态回执，退出 1，任务仍 running、attempt=1、retry_count=0，水位与非法输出计数均未推进。没有停真实数据库。
- 真实已安装 LangChain／DeepSeek＋本地 HTTP MockTransport 验证 SDK 最终序列化、tools／schema、thinking、可观察重试、E/V/A 各自调用与原始供应商返回。默认 HTTP priority 工厂另经真实 SDK 零候选回环验收验证传入生产 hooks 和 Runner 线程上下文；其余脚本模型公共 HTTP 用例明确 `provider_capture=not_observable`，两层验证不互相冒充完整真实服务集成。

### 验证与数据影响

所有 Python 命令先启用 Conda `NotAlone`，`PYTHONPATH=src:.`、`NOTALONE_DISABLE_DOTENV=1`；测试包装器删除 API_KEY／LANGSMITH／LANGCHAIN／代理环境并拒绝非回环网络。数据库只用主任务新建的 `notalone_memory_trace_be5912528896_test` 和 HTTP 夹具自建随机 `_test` 库；夹具自建库清理后残留为 0，固定隔离库留主任务最终清理。042 只应用到隔离库，已应用的 039／040／041 校验值保持；未读取 `.env`／凭据、私人数据库、真实微信或调用真实模型，没有 push／远端分支／PR。

- `python -m unittest discover -s tests/unit -t . -q`：949 项通过，含 5 项真实 SDK／本地 transport 验证；原有合成 SKILL 读取拒绝诊断不影响成功。
- `python -m unittest tests.integration.ingest.test_source_processing_trace tests.integration.ingest.test_import_command tests.integration.persistence.test_postgres_repository tests.integration.persistence.test_observation_store tests.integration.persistence.test_source_deletion tests.integration.persistence.test_source_reply_deletion tests.integration.persistence.test_observation_reply_deletion tests.integration.front_sync.test_front_sync_end_to_end tests.integration.front_sync.test_tail_lifecycle tests.integration.memory_extraction.test_extraction_trace tests.integration.persistence.test_postgres_outbound_ledger tests.integration.persistence.test_postgres_owner_memory tests.integration.tasks.test_worker tests.integration.tasks.test_task_retention -q`：197 项通过。
- `python -m mypy --no-incremental --cache-dir /dev/null --follow-imports=silent --ignore-missing-imports`：本任务 16 个无既有诊断的生产文件通过。基线 `2401dc4` 与当前 app／server command／Worker 三文件均 73 项既有诊断（59／5／9），逐项信息相同、0 新增；其余五个既有诊断文件也与基点逐项比较，两侧均 123 项（adapter 3、postgres_repository 11、observation_store 16、tail_lifecycle 2、cli_sync 91）、0 新增。没有宣称全仓 mypy 通过。
- `python -m unittest tests.integration.server.test_memory_trace_api tests.integration.server.test_import_auto_flow tests.integration.server.test_model_priority_lifecycle tests.integration.server.test_core_business_flow tests.integration.server.test_first_import_api tests.integration.server.test_import_task_api tests.integration.server.test_failed_task_recovery -q`：81 项通过，其中本任务公开 HTTP／CLI 20 项；回环连接关闭时仍有既有 `ConnectionResetError` 诊断，无正文，测试成功。五个自建合成测试库清理后残留 0。
- Python 文件整理、`git diff --check` 通过。后端提交 `6af8e989447cc92f89c23b8c40cb46bfbff05227`，父基点 `2401dc472a4c8de3960eafcb6ffa1ebf13c7debd`；交付前合入最新本地集成 tip，交付说明另作本地提交。最终固定 SHA 与 clean／祖先证据由主任务交付记录补充。

### 两轴评审后的共同后端修复

2026-10-08：从 clean `de6c9da005dc0c4812bf22775c98e3cf2b8f9f61` 统一修复 Spec 的 2 项 P1／3 项 P2 和 Standards 的 1 项明确违规／1 项已采纳维护建议。没有修改 What to build 或 App 验收，`State: claimed` 与未完成勾选保持；后续独立复验由主任务安排。

1. 手输本人记忆：公开 `memory_add_main → run_extraction → query/delete` 原先在零／非零候选的 `memory_pool` 阶段报 `TraceWriteError`。保留原始版本中的 `source_ids`，只把明确的手输 owner UUID 归属哨兵排除出物理来源依赖，自身 `memory_id` 始终保留；其他模型／真实来源继续校验。两类批次成功并推进水位，删除本人资料清除两批副本。生产 HTTP 自动非零提取、默认 priority 工厂＋真实已安装 SDK／本地 HTTP transport 的零候选提取另有公开覆盖；未增加资料编辑产品接口或改变 owner 记忆范围。
2. 已删历史快照：公开读取先缓存同一规范消息的 legacy A／B 两个来源，再通过来源删除接缝删除 A。原测试未阻断旧缓存；现在 begin 在同一范围锁和事务内核对每份实际缓存的消息、source/ref、范围、存活与原始投影，再保存窗口，删除后的 A 在模型调用前失败且不推进水位。重新读取保留活 B 的完整原文，旧处理链仍标 missing，删除 B 仍清除批次。既有来源处理记录手删后的缓存拒绝回归保持。
3. 消息正查：公开 `/memory-traces/records/message/{id}` 原先返回 400，现经查询服务、默认 HTTP 和 CLI 返回实际使用该消息的提取批次；目标、仅上下文、零候选和失败批次均覆盖。跨 owner／contact 与不存在统一 404/no-store，来源处理与提取批次分别返回。迁移 043 加入 message 输入关联及 input/save/invalidate 操作；输入关联不冒充业务写入回执。043 前已有真实窗口可直接查询，清正文前只保留其无正文消息标识，之后显示 deleted；早已清除且无关联的历史仍 not_recorded，不重建正文。
4. 失效部分提交：联系人 UPDATE 的旧记忆已经实际失效、write_result 追踪失败时，原查询缺少旧行回执。现在联系人和 SELF／owner 两条持久分支都先登记 invalidate 计划与真实 ID；查询／retry reconciliation 核对权威 invalidated 状态，返回 committed、当前状态及明确的非历史重建标记。两条公开故障路径及重试都通过，重复运行保持仅一条新 active 记忆。实际失效前业务故障时旧行仍 active，只报告 unknown；不能因旧行存在就伪报失效提交。逐条事务、模型裁决语义和采纳门槛不变。
5. 安全导入校验：公开 import→处理追踪原先只有统一 `input_invalid`。六类同一行输入现区分 sender 身份缺失、必填字段缺失、时间格式、时区、时间一致性和字段类型；保存稳定 `error_code`、具体 `fields`、规则标识 `rule`、实际阶段和行定位。失败记录不含 exception.message、校验前正文、无效时间原值或未验证原始资料。文件级身份／范围与其他字段规则也提供对应的安全类别和字段。
6. 规则摘要适配边界：`source_processing.models.execution` 移除文件读取与当前时刻读取，只接收摘要和实际时刻构造纯快照。小型 `source_processing.rule_capture` 文件 Adapter 在真实 parse／normalize／筛选／持久化边界逐次取得当时文件 SHA-256 与结束时刻，不永久缓存版本；导入、CLI／前台同步公开回归保持时间语义。公开导入记录进一步核对真实规则文件摘要。
7. 失败状态共享：合成与 PostgreSQL Adapter 共用 `memory_trace.status.failure_status` 纯映射；追踪失败、停止、来源／租约失效、guard 持久故障和普通业务故障仍由既有公开失败／晚返回路径验证，没有新增镜像私有函数测试。

### 本轮验证与数据影响

沿用本任务 Conda、明确源码路径、关闭 dotenv／凭据与非回环网络的包装器。043 仅应用主任务固定 `notalone_memory_trace_be5912528896_test`；HTTP 夹具在新建随机 `_test` 库逐次应用完整迁移并自行清理，报告残留 0。039–042 已应用迁移内容和校验值未改，未迁移私人库、读取 `.env`／凭据、执行真实微信／模型、push／远端分支／PR。新增长期留存资料只是既有受范围批次的无正文消息／写入操作标识和安全规则定位；正文仍按原删除路径清除。

- 全部 unit：949 通过，日志 `/tmp/notalone-trace03-review-fix-unit-validation.log`。
- 与上节相同完整 14 模块 PG 命令：204 通过；最后旧窗口删除关联改动后再次运行该相关命令，204 通过，日志 `/tmp/notalone-trace03-review-fix-pg-validation.log`。新增来源／提取链 51 项也单独通过，日志 `/tmp/notalone-trace03-review-fix-final-chain-validation.log`。
- 与上节相同完整 7 模块 HTTP 命令：83 通过，日志 `/tmp/notalone-trace03-review-fix-http-validation.log`，5 个自建库清理后残留 0。最后删除关联收口后重跑本任务公开 HTTP／CLI 模块，22 通过，日志 `/tmp/notalone-trace03-review-fix-final-http-validation.log`，1 个自建库清理后残留 0。未重复与最后改动无关的完整套件。
- 25 个无既有诊断的生产文件 mypy 通过，日志 `/tmp/notalone-trace03-review-fix-clean-type.log`。冻结 de6 integration 与当前 8 个既有诊断文件逐项对比，均 196 项（app 59、server command 5、Worker 9、CLI adapter 3、postgres_repository 11、observation_store 16、tail_lifecycle 2、cli_sync 91），0 新增／0 消失；日志 `/tmp/notalone-trace03-review-fix-existing-type-baseline.log` 与 `/tmp/notalone-trace03-review-fix-existing-type-current.log`。没有宣称全仓类型零错误。
- Python 格式整理核对 AST 等价，`git diff --check` 通过；本轮父基点为上述 de6，最终本地提交 SHA／clean／integration 祖先证据由主任务固定交接记录补充。

### 集成复验与收尾

2026-10-08：后端交付固定提交 `1a71b2b3142cadcac223f4b1ae86320295c9148c` 已快进合入 `codex/memory-extraction-trace`。独立 Standards 复验确认 1 项硬规范问题和 2 项维护判断均解决，剩余 0；独立 Spec 复验确认 5 项后端问题均解决，剩余后端问题 0，另有 1 项已知 App 范围缺口。共享输入关联的最终整理另经 10 项公开 SDK／内存、PostgreSQL、HTTP／CLI 回归与 3 个生产文件类型检查通过；没有重复与该小改动无关的完整套件。

已核对上述 949 项单元、204 项数据库、83 项 HTTP，以及最后 51 项来源链、22 项 HTTP／CLI 和 10 项公开回归的实际验证日志。变更文档的本地链接及 39 个 ADR、43 个迁移编号唯一性检查通过。迁移校验值未改，所有正文测试资料为合成；任务创建回执已用于精确清理 `notalone_memory_trace_be5912528896_test`，清理后残留为 0，各 HTTP 夹具自建库同样已清理。私人库未迁移，旧历史未重提取，未调用真实模型／微信，没有 push 或 PR。

01／02 保持 resolved；03 的 App 查看与刷新尚未完成，原 User Story 21 和验收范围保留，等待已提出的范围选择。

### 独立复验与输入关联维护收口

2026-10-08：独立复验 `de6 → 6bee961ea2cb5705d27221eee4134715a811c02e` 确认 Spec 原五项均解决、剩余／新增后端问题 0；Standards 原两项解决、硬违规 0。App 待决策单独保留，`State: claimed` 与未完成验收不变。

主任务采纳 Standards 新增的一项可选维护建议：合成／PostgreSQL Adapter 原先分别构造相同的消息 input 关联，现共用 `memory_trace.context.message_input_links` 小型纯构造函数。字段顺序、值类型、消息次序、`operation=input`、两 Adapter 原有 messages 必需／缺省行为完全不变；未新增抽象层、迁移、捕获内容或镜像 helper 测试。

- 最小公开回归 10 项通过：现有 5 项 SDK／InMemory 提取与查询、3 项 PostgreSQL 消息查询／旧窗口删除／上下文删除、2 项默认 HTTP／CLI 消息查询及追踪／来源处理删除。日志 `/tmp/notalone-trace03-input-link-recheck-validation.log`，本次自建 1 个 `_test` 库清理后残留 0。
- 涉及的 context／adapters／persistence extraction_trace 三个生产文件 mypy 通过，日志 `/tmp/notalone-trace03-input-link-recheck-type.log`；格式与 `git diff --check` 通过。沿用关闭凭据／dotenv／非回环网络的合成环境，数据处理边界不变；未重复无关完整套件。

### 2026-10-10：React 查看入口与隔离页面验证

用户要求按优先级推进不需人在场的待实现/待验收部分，已覆盖本票此前待定的最小 React 接入范围。沿用原查询/删除公开接缝，复用生产管理页、具名主进程控制器与认证 HTTP；未增加模型、迁移或通用 renderer 请求能力。`Triage` 恢复 ready-for-agent，双轴检查完成前暂留 claimed。

- 关系资料卡片可反查联系人/本人记忆及候选；两个批次目录保持独立，支持 20 条稳定翻页、详情、消息/来源/记录查询和确认后手动删除。阶段原始快照、调用收据、候选去向、写入关联与重试标识按实际存储展示，不补造缺失阶段或供应商输入。
- 已记录、已删除、历史未记录、手输不适用、越界/不存在与读取失败分别处理。删除追踪先清空展示，成功后权威记忆仍可从公开 HTTP 读取；不把网络未知结果当作删除成功。
- 联系人/范围代次、连接变化、读取失败和来源删除检查点取消旧请求并清空正文。真实 HTTP 响应暂缓后切换联系人，以及来源删除期间的迟到响应均不得回填。查看只向可信 manager 发布；helper 查询拒绝，helper 订阅收不到追踪正文事件。
- 本次没有 Swift 改动，原生探针未运行。此前默认装配、停止、未知提交、旧记忆依赖等后端证据继续保留；本次不将普通页面作为原生 IPC、签名包或真实微信验收。

实际命令（桌面命令前激活 Conda NotAlone）：

- `npm run test:pages -- --case memory-traces --timeout-seconds 90`：最初因缺页面为 red，接入后通过基础缺口组。
- `npm run test:pages -- --case memory-traces-full --case memory-traces-lifecycle --timeout-seconds 180`：完整组通过；生命周期组的测试输入与已删除事件预期经生产契约纠正后，单独以 `--case memory-traces-lifecycle --timeout-seconds 120` 通过。当前生产代码相同。三个具名组均通过；没有把失败整次命令称为通过。
- `npm test`：页面进程完全收尾后，类型检查及 24/24 安全调度检查通过。此前并行运行的状态检查因本轮页面租约仍存在而失败，未改门禁以掩盖该失败。
- Conda 中清除模型/外部 tracing/代理环境，禁用 dotenv 并拒绝非回环连接，运行 `python -m unittest` 等效 loader 的 `tests.integration.server.test_memory_trace_api`、`tests.unit.memory_extraction.test_dimensions`、`test_adoption`、`test_evaluation`、`test_flow`：110 项通过。
- 页面每轮只用一个无头 Chrome，全部采样 active=0、屏上窗口=0，自有资源清理确认，Electron=false、nativeAcceptance=false。正式提取夹具只用确定性脚本模型，数据及页面截图全部合成；随机 `_test` 库由精确本轮回执清理。未读取私人聊天或业务库、迁移私人库、读取模型凭据、调用供应商、开启微信、改系统剪贴板或 push。

两轴 review 和最终本地提交记录随后补齐。
