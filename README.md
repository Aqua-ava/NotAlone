# NotAlone

NotAlone 是面向用户真实联系人的中文关系感知回复助手。用户确认联系人与桌面会话后，导入历史聊天或开启已确认联系人的后台增量同步；系统检索同一联系人的关系资料并生成候选回复，由用户选择、修改并亲自发送，产品不会代发消息。

仓库当前保留的路径：微信单联系人 JSONL 只读预览、联系人确认后的 PostgreSQL 正式导入、CLI 后台增量同步（前台 OCR 只负责定位当前会话）、记忆提取与管理、检索评测，以及 Python 本地后台的候选回复接口。代码中不存在发送消息 Tool；验证以合成数据、scripted fake model 和本地适配器为主，真实 DeepSeek 冒烟需显式配置凭据后运行。

旧 Swift 主界面 `macos_app/` 已删除。新的 Electron + TypeScript/React 桌面端已接入管理窗口、小窗与主要业务流程；完整原生交付仍待验收。Python 后台位于 `backend/`，Mac 原生截图、OCR、会话定位探针位于 `native/macos/`；Windows 微信适配尚未实现，见 [ADR-039](architecture/adr/039-retire-swift-main-interface.md)。

## 仓库目录

```text
NotAlone/
├── backend/          Python 后端：源码、测试、SQL 迁移与 pyproject.toml
├── desktop/          Electron + TypeScript/React 桌面端与受限验收
├── native/macos/     Swift 原生截图、OCR 与会话定位探针
├── website/          独立静态官网
├── scripts/          仓库级安装与部署入口
├── docs/             工程、操作及验证说明
└── architecture/     领域设计、现行规格与 ADR
```

Python 与原生探针各自管理依赖、构建和测试；领域代码不放入桌面界面。详细入口见 [后端说明](backend/README.md)、[桌面端说明](desktop/README.md)与 [Mac 原生探针](native/macos/README.md)。`.env` 与私人导入目录 `chat_exports/` 仍位于仓库根目录，并由 Git 忽略。除单独注明外，下列命令从仓库根目录执行。

## 环境要求

需要自行准备：

- macOS 15+ 与 Xcode 16.4 / Swift 6（用于保留的原生探针）
- 微信桌面版，以及自装 `wechat-cli`
- PostgreSQL（安装脚本默认创建本地库 `notalone_dev`）
- conda（安装脚本创建 Python 3.12 的 `NotAlone` 环境）
- 屏幕录制权限，授予实际执行定位的探针；权限归属与签名说明见 [权限记录](docs/macos-app-permissions-and-errors.md)
- DeepSeek API Key（可选；未配置时真实模型入口失败关闭）

## 安装与首次配置

机器级安装只做环境准备、不读写密钥，可安全重复运行：

```bash
zsh scripts/install.sh
```

脚本按顺序完成：检查依赖（macOS / Homebrew / conda / PostgreSQL / swiftc）→ 创建 `NotAlone` conda 环境并 `pip install -e ./backend` → 启动本地 PostgreSQL 并创建 `notalone_dev` → 按版本记录应用尚未完成的 `backend/database/migrations/*.sql` → 生成只含数据库连接的受控根 `.env`（0600）→ 构建前台同步探针。每个迁移与成功记录同事务提交，失败只回滚当前迁移，重跑从未完成版本继续；机器环境等此前已完成步骤会保留。无迁移记录的旧库会停止并提示核验，不会凭 `owner` 表猜测基线或重放历史 SQL，见 [数据库迁移说明](backend/database/README.md)。

桌面首启支持显式初始化身份，CLI 仍可使用下文历史导入的 `--initialize-owner`；模型凭据通过本地受控 `.env` 或环境变量提供。安装脚本不填写密钥，也不启动真实微信读取。探针的独立构建与调试见 [native/macos/README.md](native/macos/README.md)。

Python 命令必须在 conda 环境 `NotAlone` 中运行；命令启动时自动读取当前或上级目录的 `.env`，已有 shell 环境变量优先：

```bash
conda activate NotAlone
python -m pip install -e ./backend
```

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `NOTALONE_DATABASE_URL` | PostgreSQL 连接串（本地示例 `postgresql:///notalone_dev`） |
| `NOTALONE_OWNER_ID` | 当前 owner UUID；首次导入可用 `--initialize-owner` 生成并写回 `.env` |
| `NOTALONE_ENV_FILE` | 指定受控 `.env` 路径（默认当前或上级目录） |
| `NOTALONE_WECHAT_CLI` / `NOTALONE_SYNC_PROBE` | 覆盖 `wechat-cli` / 同步探针可执行文件路径 |
| `NOTALONE_DEEPSEEK_API_KEY` | 模型凭据；缺失或为空时构造失败，错误不回显凭据 |
| `NOTALONE_DEEPSEEK_MODEL` | 覆盖模型名，默认 `deepseek-chat`（支持工具调用与结构化输出） |
| `NOTALONE_DEEPSEEK_BASE_URL` | 覆盖默认官方 API 地址（中转或代理服务） |
| `NOTALONE_TEST_DATABASE_URL` | 隔离测试库，名称必须以 `_test` 结尾 |
| `NOTALONE_MEMORY_DIMENSION_GATE` | 记忆按维度放行开关；只有显式 `0` 才关闭，关闭后恢复"通过原有三道门槛即自动采纳"（见 ADR-036） |

`.env` 已被 Git 忽略，不应提交或分享。

## 常用命令

### 微信增量同步

同步分为两个独立通道：CLI 后台按各联系人自己的 cursor 读取文字增量；前台 OCR/探针只定位当前微信联系人，失败不影响 CLI 后台同步。原始视觉帧不保存，消息按稳定身份写入并与历史导入跨来源去重。

当前支持桌面同步管理页及下列 CLI 入口；用户确认绑定后开启总开关，不会自动授权新增会话。关闭总开关或退出后端运行时停止读取；重新开启后只对仍有效的已确认绑定补齐 baseline 之后的可检测缺口，不读取未确认会话正文。新桌面宿主已接入退出停读，最终原生验收状态见桌面说明。

```bash
export NOTALONE_DATABASE_URL='postgresql:///notalone_dev'
export NOTALONE_OWNER_ID='00000000-0000-0000-0000-000000000000'

notalone-front-sync enable      # 手动开启 CLI 后台增量同步
notalone-front-sync contacts    # 列出 CLI 可见私聊，供绑定确认选择
notalone-front-sync confirm-binding --contact-id '...' --locator 'wxid...'
notalone-front-sync status      # 执行一次双通道检查，输出 CLI 后台与前台 OCR 状态
notalone-front-sync disable     # 手动关闭并停读；重新开启后的有界补齐遵循 ADR-025
```

绑定只接受 CLI 返回的私聊会话定位标识，不用昵称猜测联系人；用户确认后才为新会话创建本地联系人，已绑定会话不会静默改绑。输出只含状态、计数、展示名称与候选标识，不含消息正文。CLI 全局流不可用时退化为有界一次性轮询。已有安装升级前先查看 [数据库迁移说明](backend/database/README.md)；无版本记录的旧库需要单独核验，安装脚本不会自动接管。

### 历史导入

先预览：校验完整文件、识别本人和唯一联系人、统计消息类型；文件损坏、混多位联系人或字段不符时非零退出，错误只含行号和字段。单文件上限 64 MiB、500,000 条消息。默认隐藏文件名与联系人标识，仅在需要人工核对时显示（只影响当前终端，不写数据库）：

```bash
notalone-ingest-preview chat_exports/example.jsonl
notalone-ingest-preview --show-identifiers chat_exports/example.jsonl
```

正式导入前必须先预览并人工选择一个已有联系人，或明确创建新联系人（`--contact-id` 与 `--new-contact-name` 二选一，分别写入 `manual_select` / `manual_create` 确认）：

```bash
notalone-ingest chat_exports/example.jsonl --contact-id '11111111-1111-1111-1111-111111111111'

notalone-ingest chat_exports/example.jsonl \
  --initialize-owner --new-contact-name '联系人展示名称'
```

首次导入或显式恢复 owner 时使用 `--initialize-owner`：同一事务创建或恢复 owner、保存 owner 渠道身份并绑定联系人；成功后生成的 owner UUID 会写入受控 `.env`，后续导入不再需要。联系人、来源、确认记录与全部消息同事务写入，任一步失败整体回滚；同一 `owner_id + contact_id + SHA-256` 的 active 来源重复执行不重复写入，不同 SHA 文件复用相同 `(id.local_id, create_time)` 消息身份会拒绝整批导入。输出只含状态和消息数量，不含聊天正文与各类 ID。

### 删除导入资料与查看回复依据

本地后端按已确认联系人列出导入来源，支持删除单份导入并查询后台步骤与结果；中断、失败或 Worker 忙时可重新请求继续删除。请求与结果保存到数据库，不依赖模型密钥，当前通过 HTTP 接口使用这些能力。升级需先按[数据库迁移说明](backend/database/README.md)应用 `036_source_deletion_tasks.sql`，本仓库修改不会自动迁移现有业务库。

删除清除 NotAlone 中该来源及失去来源的聊天、记忆历史正文和回复快照；共享来源支持的资料保留。微信聊天、用户原始文件和不含正文的最小 AI 调用记录保留，外部模型副本须按供应商规则另行处理。联系人/账户整体删除不由此入口提供。缺少可核验删除任务的旧凭证（含任务已过期清理）不显示为本轮删除完成，历史正文残留需要单独核验。

后台依据接口返回生成时实际保存的上下文正文、选入原因与候选引用；读取不重新检索，也不触发模型调用。HTTP 接口分别为 `GET /api/contacts/{contact_id}/sources`、`DELETE /api/contacts/{contact_id}/sources/{source_id}` 和 `GET /api/contacts/{contact_id}/replies/{reply_request_id}/evidence`，沿用回环服务 token 与 owner/contact 隔离。

普通草稿润色使用本次草稿、指令、受控 Skill 和用户明确选择的续写候选，模型默认不能调用历史检索工具或引用历史消息与记忆。明确设置 `include_relationship_context=true` 后，才允许在已确认联系人范围内检索背景资料；正常回复消息保留该范围内的有界检索能力。

### 记忆提取与管理

```bash
notalone-extract-memory --contact-id '...'   # 自动全量/增量；中断重跑跳过已提取部分
notalone-task-worker --contact-id '...'      # 处理一个后台任务：parse → normalize → extract_memory → index → verify
notalone-task-worker --contact-id '...' --retry-task-id '...'  # 显式恢复失败原任务并执行
notalone-memory-add --contact-id '...' --category taboo --text '...'
notalone-memory-add --category recent_state --text '我下周出差'   # owner 级自我记忆
notalone-memory-list --contact-id '...'
notalone-memory-delete --contact-id '...' --memory-id '...'
notalone-task-cleanup                        # 删除超过 90 天的终态任务元数据
```

提取候选先经证据契约与逐条来源语义核验：支持才继续原采纳门，证据不足留待确认，无支持拒绝，未核验不能自动入库。核验不改写正文、主体、来源或有效期；返回片段必须是候选来源中的真实原文，并包含主消息。之后仍执行置信度与风险门槛（低于 0.7 或带敏感/未知风险留待定）、按维度放行（ADR-036：默认放行表为空，只有已放行维度才自动采纳，其余安静待确认）、删除指纹和写入裁决，全部通过才自动采纳、标记 `auto` 并可撤销；`NOTALONE_MEMORY_DIMENSION_GATE=0` 可回退按维度放行。生产 CLI／Worker 默认用既有模型每窗口至多增加一次核验，单批最多 60 条；提取与核验各有无正文台账。网络或模型不可用时不推进该批水位；非法结构输出按 ADR-029 连续三次后记录可见跳过并推进，未跳过前不推进。Worker 模型或网络暂时失败最多自动重试 3 次并续期步骤租约，进程中断后重跑从未完成步骤继续，无任务时输出 `status=idle`。`index -> verify` 按确定性代码维护联系人记忆目录（分类、主题提示和 memory_id 引用，最多 20 个主题），不复制正文。手动录入标记 `manual`，支持联系人级与 owner 级。普通运行命令输出只含状态、计数和元数据；下面的追踪查看命令由用户主动读取完整敏感资料。目标流程见 ADR-014、ADR-015、ADR-018、ADR-033、ADR-036。

实际提取默认把全过程写入 PostgreSQL：原始来源处理记录、消息读取与窗口、提取／核验／裁决的实际输入和原始返回、逐候选规则及写入结果。生产 CLI、任务 Worker 和 HTTP 原任务使用相同记录链；本地后端的 CLI 增量同步在观察提交后自动排队联系人记忆任务；独立同步 CLI 仍只保存来源与消息。含正文追踪没有自动到期时间，保留到手动删除或来源删除；90 天任务清理不清追踪。来源删除会清除受影响整份追踪的正文，手动删除追踪保留权威消息／记忆。旧数据缺失显示 `not_recorded`，手输资料显示 `not_applicable`，从模型候选人工确认的记忆仍关联原批次。不能观察到供应商 HTTP 载荷的适配器明确显示 `not_observable`；不会用应用输入冒充最终 HTTP 请求。

```bash
notalone-memory-trace --contact-id '...' list --limit 100
notalone-memory-trace --contact-id '...' list --before '...'  # 使用上一页 next_before
notalone-memory-trace --contact-id '...' show '...'           # 主动查看完整敏感正文
notalone-memory-trace --contact-id '...' find contact_memory '...'
notalone-memory-trace --contact-id '...' find message '...'   # 正查使用该消息的提取批次
notalone-memory-trace --contact-id '...' delete '...'
notalone-source-trace --contact-id '...' find message '...'
notalone-source-trace --contact-id '...' show '...'
```

查询／删除只需要既有 `NOTALONE_OWNER_ID`、`NOTALONE_DATABASE_URL` 与已确认联系人，不构建模型。HTTP 沿用本地服务 token 和固定 owner：`GET /api/contacts/{contact_id}/memory-traces`、`GET/DELETE /api/contacts/{contact_id}/memory-traces/{trace_id}`、`GET /api/contacts/{contact_id}/memory-traces/records/{message|candidate|contact_memory|owner_memory}/{record_id}`；来源处理使用同一路径中的 `source-processing-traces` 和 `message|source_ref|source_document|local_wechat_observation`。消息可以正查实际使用它的提取批次，包括仅作上下文、零候选和失败的批次；来源处理批次另行返回。列表支持 `limit=1..500` 与 `before={next_before}`，按时间和批次 UUID 稳定翻页；游标必须属于当前联系人。所有追踪响应（包括失败）均为 `Cache-Control: no-store`，越界／不存在统一 404，不返回错误正文或数据库凭据。

追踪写入失败停止本批，返回安全的 `trace_write_failed`，不累积模型非法输出预算、不推进水位；保留已提交部分和提交回执未知状态。HTTP 导入来源记录故障返回 `source_processing_write_failed`。任务进度／SSE 只发布 `error_code` 等元数据，外层执行 `finished` 后应查原 `task_id` 的持久状态。追踪与失败状态同时不可写时，运行仍明确返回 `trace_write_failed` 和 `failure_state_commit=unknown`，结束本次执行；不宣称任务失败已落库、不返还原 attempt。停止、来源／租约失效、guard 存储故障分别记录；旧调用晚返回仍保留一次无正文调用台账和 `calls` 关联，已删正文不恢复。数据库迁移更新至 `043`；本轮仅在合成 `_test` 库验证，没有迁移私人库或调用真实模型／微信。完整后端与当前 React 管理页的批次/详情/反查/删除接入已通过合成 HTTP 和普通页面验证；资料、来源或范围变化会清除正文并取消旧请求。实现记录见 [.scratch/memory-extraction-trace/issues/03-app-and-all-entrypoints.md](.scratch/memory-extraction-trace/issues/03-app-and-all-entrypoints.md)。最终签名 App 与真实微信验收仍按独立任务推进，不由普通页面通过推导。

手输本人资料的 owner 标识只表示归属，追踪以资料自身 ID 保留删除依赖；既有资料不会阻断下一次提取。实际缓存的每份来源／引用在保存窗口前复验，已删除的原始快照即使规范消息由另一来源保留也不能复活。旧记忆 UPDATE 的失效计划和权威状态关联到同一记录，区分已失效提交与尚待核对；校验失败追踪保存稳定的 `error_code`、`fields`、`rule` 与实际定位，不复制校验前正文或无效时间原值。

自动采纳在原有三道门槛之上再叠加一道**按维度放行**（ADR-036）：一条候选还要落到已放行的维度键才会自动写入，无法明确判定维度键的候选一律视为未放行。**默认放行表为空**，因此当前所有通过原有门槛的候选都进入待确认、不新增自动采纳；放行某一类需要该维度本轮评测达标签并由用户逐类批准，记录在 [记忆维度自动采纳放行台账](docs/memory-adoption-dimension-release-ledger.md)。当前 `paraphrase`、`reference`、`media`、`reported` 四个维度缺少必要结构化字段、无法从既有提取结果推导，即使达标也不能放行。运维回退设 `NOTALONE_MEMORY_DIMENSION_GATE=0`，恢复本门启用前的行为。

导入 HTTP 提交返回原 `task_id`，消息提交后立即可用；本后端随后自动处理这次原任务，无需另外启动。重复提交复用原任务，同一任务唤醒合并；Worker 全局锁忙时持续退避等待，间隔最多 30 秒，关闭结束等待。自动处理不扫描较早的其他任务或重启前的队列，也不自动重做成功、失败或取消终态。指定任务只限定调度，提取仍使用该联系人的有效消息、既有水位和窗口；不是按单一来源独立提取。

使用 `GET /api/tasks/status?contact_id=...&task_id=...` 查询数据库中的状态与步骤，重启后仍可读取。模型配置或执行资源不足时不领取步骤，任务保持 queued，`error_code` 分别为 `model_configuration_unavailable` 或 `execution_resources_unavailable`，不包含正文；修复后显式 `POST /api/tasks/run` 提供 `contact_id + task_id` 执行。模型失败不回滚已导入消息；自动重试耗尽后，`POST /api/tasks/retry` 明确提供相同范围，将失败原任务恢复为 queued，再显式 run。恢复保留成功步骤，指定执行不会领取其他任务；来源进入删除流程后不能恢复导入任务。CLI 默认仍领取指定联系人最早的一个任务，显式恢复在配置预检查和全局锁成功后执行，忙时不修改任务。步骤 `attempt_count` 表示当前重试轮次的尝试数，手动恢复后重新获得最多三次自动尝试；任务 `retry_count` 累计失败和手动恢复次数，不代表累计模型调用数。

默认启动继续领取最早可执行任务；显式恢复按原任务领取的局部例外见 [ADR-034](architecture/adr/034-explicit-failed-task-recovery-selection.md)，全局串行锁和预检查不变。

本地后端中的候选回复优先于尚未开始的后台提取、来源核验与写入裁决调用。已开始的一次适配器调用（包括 SDK 内部重试）结束后，等待回复先执行；整次回复完成前暂停后续后台模型调用。等待发生在候选请求租约与 20 秒生成计时之前，独立 CLI Worker 保留原行为。

`POST /api/runtime/shutdown` 和服务器公开关闭共用停止协议：拒绝新工作、唤醒许可等待者，当前实现共享 4 秒收尾预算。不能中断的旧调用返回后丢弃结果，不把未完成任务标为成功；成功步骤保留，原租约到期后可按原任务显式继续。协作停止在有效来源与租约内返还本次尝试，真实模型失败仍计入三次预算；来源或租约已失效、进程被强制结束、停止记账不可用时不保证返还。调用许可与锁连接统一收尾，已发生的调用仍保留无正文台账。行为约束见 [ADR-038](architecture/adr/038-import-triggered-memory-work-and-reply-priority.md)，合成 HTTP 验收覆盖上述范围，不代表外部模型或正式部署已验收。

后台记忆接口为候选、联系人记忆和本人记忆返回来源聊天时间、保存／录入时间，
以及存在的生效／失效时间。来源跨多条消息时返回日期范围，缺失或无法核实的时间
保留未知或不完整状态；历史已完成操作也保留来源日期。已有资料直接从原来源取得
时间，无需重新提取。来源日期表示当时说过，不代表事件恰在当天发生，也不保证旧状态
今天仍成立。候选回复同时读取这些时间，并保存到本次依据快照供回看。

模型置信度表示模型对提取结果的把握，不等于实测准确率；来源支持也不证明现实真伪。旧记忆不自动重提取或补认证。

生产记忆 CLI／Worker 的共享模型（提取、来源核验、写入裁决）开启既有思考模式；回复模型不变。配置的服务须支持 `thinking.type=enabled` 与结构化工具结果。本轮同批来源对照改善了错误自动采纳和事实覆盖，但仍有错误／歧义候选，且耗时明显增加；范围、残留与验证见 [语义与来源复测](docs/memory-source-scope-fidelity-20261002.md)。

### 检索评测

只使用合成联系人、消息和来源，不读取真实聊天、不写生产库：

```bash
notalone-retrieval-evaluate            # 内存契约评测
notalone-retrieval-evaluate --json
(cd backend && python -m unittest tests.integration.persistence.test_retrieval_evaluation)   # PostgreSQL SQL/全文路径
```

评测覆盖同义表达、确切短语、时间条件、无结果、冲突和跨联系人隔离，记录空结果率、降级率、Top-K 命中、引用纠错率、候选拒绝率、延迟、Token 和 Tool 次数；没有匿名运行观察值时引用纠错率与候选拒绝率显示为 `N/A`。向量候选当前不启用；只有持续检索异常、真实反馈、provider 配置和隐私评审同时满足才进入后续决策，SQL/全文路径仍是唯一生产检索路径。

### 记忆召回评测

```bash
(cd backend && python -m unittest tests.unit.retrieval.test_recall_evaluation)
```

109 条合成中文用例覆盖直述、改写、无关拒绝、跨联系人隔离、失效与删除、双预算和排序七个维度；评测装配真实评分器与真实回复上下文组装，不连接数据库、不调用模型、不需要凭据，门槛作为常规测试断言。结果与常量标定见 [`docs/memory-recall-evaluation-baseline.md`](docs/memory-recall-evaluation-baseline.md)。

### 记忆提取准确率评测

```bash
python -m notalone.memory_extraction.evaluation  # 默认跳过，退出码 2
# 专用 NOTALONE_EVALUATION_API_KEY 由 shell 安全注入，不写入命令历史
python -m notalone.memory_extraction.evaluation --dimension subject
python -m notalone.memory_extraction.evaluation --thinking  # 与生产记忆相同模式；评测默认关闭，便于对照
python -m notalone.memory_extraction.evaluation --baseline  # 仅合成资料：测原门槛潜在去向
```

评测不读取 `.env` 或真实聊天、不连接数据库、不写入记忆；仅显式提供专用凭据时发送仓库内合成用例。模型名和地址沿用 `NOTALONE_DEEPSEEK_MODEL`、`NOTALONE_DEEPSEEK_BASE_URL`。输出 JSON 行中的模型字段、最终 `auto/pending/none`、期望对比和失败汇总；退出码 0 为全通过，1 为存在失败。也支持重复 `--case` 按用例名选择。

保留旧 120 条七维度用例，另有 15 个独立来源场景的逐命题挑战，其中 6 个为预留变体。
默认评测同时走来源核验，`--baseline` 只对固定仓库合成集合测未经核验的潜在去向，不提供生产绕过入口。
逐候选完整对照允许命题、主体、限定、时间与去向，并检查每条期望命题召回；正确输出不能覆盖额外错误。
自动无支持主张计安全错误，记错人独立计数。汇总的达标签按 ADR-027 第 2 条判定：该维度用例数 ≥15、假事 0、记错人 0、一般错误 ≤1；
语义标注覆盖（`semantic_cases`／`semantic_scenarios`）作为单独字段如实报告，不参与达标签判定，未标注用例不能证明语义维度达标。
达到门槛只是放行某一维度的必要条件，仍需用户逐类批准并记入 [放行台账](docs/memory-adoption-dimension-release-ledger.md)（见 ADR-036）。
同义正则是受控测试 oracle，未匹配结果仍需核对原文，不代表通用语义证明。
`auto` 表示通过正式采纳门的路径，评测不执行存储去重或写入裁决，也不叠加运行时的维度放行门（否则未放行维度永远无法积累放行证据）；不能从有限合成结果推断真实聊天准确率。

独立方法复刻实验提供现有方式、叙事后提取、来源时间精修和组合四条路径：

```bash
python -m notalone.memory_extraction.replica_experiment --split all --repetitions 2 --output-dir /tmp/new-synthetic-output
```

仍需显式专用评测凭据，只处理 24 个固定合成场景，不挂接生产或写入记忆。独占保留首次输出，隐藏方法后按中文 gold 逐项复核，语义、时间、漏提及调用成本分别评分；运行完成不等于语义达标。[2026-10-02 实验报告](docs/memory-method-replication-experiment-20261002.md)记录了局部收益和残留错误，当前没有替换默认提取。

主体与事实状态的后续迭代使用两组独立合成场景、固定正负候选及自然提取对照；保留较小的提示词修正，不引入叙事阶段或放宽采纳门槛。局部收益与未解决错判见 [第一轮迭代报告](docs/memory-subject-state-iteration-20261002.md)，真实聊天验收对照只保存在本机私有目录。

## 测试

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 python -m unittest discover -s backend/tests -t backend -v
```

测试只使用合成数据，不读取 `chat_exports/` 中的私人资料。PostgreSQL 集成测试默认使用本地 `notalone_test` 库，也可用 `NOTALONE_TEST_DATABASE_URL` 指定其他以 `_test` 结尾的隔离库；每个用例使用随机 owner 并只清理自己的合成数据，测试拒绝连接名称不以 `_test` 结尾的数据库。

### 核心业务闭环验收

```bash
conda activate NotAlone
(cd backend && NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.integration.server.test_import_auto_flow tests.integration.server.test_core_business_flow -v)
```

此验收从公开回环 HTTP 入口串联“预览 → 确认联系人 → 导入 → 自动处理原任务 → 检索 → 候选与依据 → 同键重放 → 删除来源”，并通过公开 shutdown 验证关闭边界。导入、生产 Worker 装配、固定任务步骤、记忆存储、PostgreSQL 检索和候选存储均使用真实模块，只有模型使用 scripted fake。用例在提交之前准备模型脚本与 Event，自建、迁移并清理随机 `_test` 库，需要本机 PostgreSQL 和建库权限，不使用现有业务库或外部模型凭据。

它验证核心接线、联系人隔离、来源依据、幂等、失败恢复、锁忙等待、旧队列边界与删除；不证明真实模型的语义质量或微信现场集成可用。空表达方向的建议流程属于后续业务工作。

增量观察的联系人级记忆任务已有持久状态与 Worker 接缝：复用同一任务身份，执行
`extract_memory → index → verify`，沿用联系人消息水位、失败恢复和来源删除规则。
运行中再次排队保留下一轮，不重置当前租约；每次领取有独立代次，旧结果不能完成新轮次。
本地后端已接入观察提交后的自动创建／唤醒：数据库复验原始绑定与来源，按批次登记
排队凭证，重复事件不重开已结束轮次；运行中新批次保留下一轮。锁忙保留唤醒，缺少
模型配置保持 queued；修复后可显式执行或由新观察继续。新观察可恢复失败轮次，
无新资料不重开失败预算，重启不扫描旧队列。解绑、来源删除和停止后拒绝晚事件。
调度失败仅记录 `observation_memory_schedule_failed`，不回滚消息和游标；可再次通知
或由后续新观察继续。仅后端宿主接线，独立 `notalone-front-sync` 不自动提取。

合成验收：`(cd backend && NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.integration.server.test_observation_auto_flow -v)`，
使用真实 PostgreSQL、观察存储、Worker 与脚本模型，自建并清理随机测试库。
同秒消息按入库时间再按 ID 排序；更早时间戳的历史回补仍受原联系人水位规则限制。
既有数据库使用前需受控应用至迁移 047；本轮只迁移隔离测试库，未验收真实微信或外部模型。

## 进一步阅读

- [CONTEXT.md](CONTEXT.md)：统一领域词汇
- [architecture/](architecture/README.md)：现行规格、设计草案与 ADR 索引
- [记忆维度自动采纳放行台账](docs/memory-adoption-dimension-release-ledger.md)：当前放行表、放行证据与回退步骤
- [docs/agents/](docs/agents/)：工程、领域与任务工作流
- [website/](website/README.md)：产品官网（本地预览与部署）
