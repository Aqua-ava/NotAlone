# 03：在 App 查看全过程并接通所有默认提取入口

Triage: ready-for-agent
State: claimed
Blocked by: 01, 02

## What to build

用户在 App 从关系记忆或待确认候选查看完整提取过程，也能查看没有保存记忆的批次、失败与重试。所有实际执行的提取入口默认记录；用户可以手动删除追踪，旧资料显示真实缺口，来源删除后不再恢复正文。

## Acceptance criteria

- [ ] App 提供受授权的批次列表、详情与候选/记忆反查，展示每步实际输入输出、规则、状态和关联。
- [ ] 手动删除追踪不误删权威记忆，已删/未记录/手动资料不适用与失败状态区分，刷新不会跨联系人显示。
- [ ] 历史任务、后台增量、CLI 和人工触发全部生产装配默认记录，无静默关闭或绕过。
- [ ] 故障、部分写入、零候选、重试与水位一致性贯通到任务状态和 App 展示。
- [ ] 全链来源删除、旧记忆依赖、本人归属和跨 owner/contact 隔离集成验证通过，普通日志和最小台账无正文。
- [ ] 运行相关 Python/Swift 验证、完整相关测试与 Standards/Spec 两轴 review，更新实际实现状态并本地提交。

## Comments

2026-10-07：依赖 01 的追踪与 02 的原始来源处理，才能在 App 声称展示新输入的完整链路。不会为展示效果调用真实模型或重提取旧记忆。

2026-10-08：开始交付所有共同后端范围；ADR-039 已退役 Swift 主界面，新 React 界面由后续设计任务处理。本任务 App 验收保持待办，后端实现不修改旧界面或新建前端。


## Answer

2026-10-08：共同后端范围已交付。App 查看与刷新验收保持待办，`State: claimed` 不提前改为 resolved；ADR-039 已移除 Swift 主界面，本任务不重建旧界面或新增 React 界面。最终 Standards／Spec 两轴 review 由集成主任务统一执行，本 Answer 不宣称全规格完成。

### 后端能力

- 新 `TraceService` 统一验证已确认的 owner/contact，默认 `create_app` 注入 PostgreSQL 提取与来源处理查询 Adapter；无需构建模型或配置模型凭据。HTTP 支持两类批次列表、详情、反查与手动删除，联系人的列表使用 `limit=1..500` 和 `before=next_before`，按时间＋批次 UUID 稳定继续读取更旧批次；游标范围同样验证。候选／联系人记忆／本人记忆以及 message／source_ref／source_document／local_wechat_observation 使用各自公开反查入口。不存在与越界统一 404，所有追踪类响应（含 401/400/404/500/503 与请求前置错误）no-store，不回显正文、SQL、密钥或凭据。
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
