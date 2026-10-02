# NotAlone

NotAlone 是面向用户真实联系人的中文关系感知回复助手。用户确认联系人与桌面会话后，导入历史聊天或开启已确认联系人的后台增量同步；系统检索同一联系人的关系资料并生成候选回复，由用户选择、修改并亲自发送，产品不会代发消息。

仓库当前可运行的路径：微信单联系人 JSONL 只读预览、联系人确认后的 PostgreSQL 正式导入、CLI 后台增量同步（前台 OCR 只负责定位当前会话）、记忆提取与管理、检索评测，以及本地 macOS App 中的候选回复纵切。候选只在应用内展示，代码中不存在发送消息 Tool；验证以合成数据、scripted fake model 和本地适配器为主，真实 DeepSeek 冒烟需显式配置凭据后运行。

## 环境要求

需要自行准备：

- macOS 15+ 与 Xcode 16.4 / Swift 6（App 和探针是原生应用）
- 微信桌面版，以及自装 `wechat-cli`
- PostgreSQL（安装脚本默认创建本地库 `notalone_dev`）
- conda（安装脚本创建 Python 3.12 的 `NotAlone` 环境）
- 屏幕录制权限，授予构建出的 App；稳定签名下重建不需要重新授权
- DeepSeek API Key（可选；未配置时真实模型入口失败关闭）

## 安装与首次配置

机器级安装只做环境准备、不读写密钥，可安全重复运行：

```bash
zsh scripts/install.sh
```

脚本按顺序完成：检查依赖（macOS / Homebrew / conda / PostgreSQL / swiftc）→ 创建 `NotAlone` conda 环境并 `pip install -e .` → 启动本地 PostgreSQL 并创建 `notalone_dev` → 按版本记录应用尚未完成的 `database/migrations/*.sql` → 生成只含数据库连接的受控 `.env`（0600）→ 构建 macOS App 与前台同步探针。每个迁移与成功记录同事务提交，失败只回滚当前迁移，重跑从未完成版本继续；机器环境等此前已完成步骤会保留。无迁移记录的旧库会停止并提示核验，不会凭 `owner` 表猜测基线或重放历史 SQL，见 [数据库迁移说明](database/README.md)。

用户级首次配置由 App 首启向导完成：

```bash
open macos_app/build/NotAloneApp.app
```

向导引导填写模型凭据（界面不回显）并初始化 owner；owner 初始化与导入命令的 `--initialize-owner` 共用同一张 owner 表和幂等语义，完成后 App 自动重启后端进入主界面。App 的构建、权限与启动错误见 [macos_app/README.md](macos_app/README.md)。

Python 命令必须在 conda 环境 `NotAlone` 中运行；命令启动时自动读取当前或上级目录的 `.env`，已有 shell 环境变量优先：

```bash
conda activate NotAlone
python -m pip install -e .
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

`.env` 已被 Git 忽略，不应提交或分享。

## 常用命令

### 微信增量同步

同步分为两个独立通道：CLI 后台按各联系人自己的 cursor 读取文字增量；前台 OCR/探针只定位当前微信联系人，失败不影响 CLI 后台同步。原始视觉帧不保存，消息按稳定身份写入并与历史导入跨来源去重。

首次在 App 的同步管理页手动勾选联系人（默认不选，也可主动全选当前未绑定列表），最终确认绑定后再开启总开关。刷新列表不会自动选中新会话。应用退出或开关关闭时停止读取；重新开启后只对仍有效的已确认绑定补齐 baseline 之后的可检测缺口，不读取未确认会话正文。

```bash
export NOTALONE_DATABASE_URL='postgresql:///notalone_dev'
export NOTALONE_OWNER_ID='00000000-0000-0000-0000-000000000000'

notalone-front-sync enable      # 手动开启 CLI 后台增量同步
notalone-front-sync contacts    # 列出 CLI 可见私聊，供绑定确认选择
notalone-front-sync confirm-binding --contact-id '...' --locator 'wxid...'
notalone-front-sync status      # 执行一次双通道检查，输出 CLI 后台与前台 OCR 状态
notalone-front-sync disable     # 手动关闭并停读；重新开启后的有界补齐遵循 ADR-025
```

绑定只接受 CLI 返回的私聊会话定位标识，不用昵称猜测联系人；用户确认后才为新会话创建本地联系人，已绑定会话不会静默改绑。输出只含状态、计数、展示名称与候选标识，不含消息正文。CLI 全局流不可用时退化为有界一次性轮询。已有安装升级前先查看 [数据库迁移说明](database/README.md)；无版本记录的旧库需要单独核验，安装脚本不会自动接管。

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

导入页的“已导入的聊天资料”按当前联系人列出来源，可删除单份导入并查看后台步骤与结果。中断、失败或 Worker 忙时可“继续删除”；请求与结果保存到数据库，不依赖模型密钥。升级需先按[数据库迁移说明](database/README.md)应用 `036_source_deletion_tasks.sql`，本仓库修改不会自动迁移现有业务库。

删除清除 NotAlone 中该来源及失去来源的聊天、记忆历史正文和回复快照；共享来源支持的资料保留。微信聊天、用户原始文件和不含正文的最小 AI 调用记录保留，外部模型副本须按供应商规则另行处理。联系人/账户整体删除不由此入口提供。缺少可核验删除任务的旧凭证（含任务已过期清理）不显示为本轮删除完成，历史正文残留需要单独核验。

回复页可展开生成时实际保存的上下文正文、选入原因与候选引用；读取不重新检索，也不触发模型调用。HTTP 接口分别为 `GET /api/contacts/{contact_id}/sources`、`DELETE /api/contacts/{contact_id}/sources/{source_id}` 和 `GET /api/contacts/{contact_id}/replies/{reply_request_id}/evidence`，沿用回环服务 token 与 owner/contact 隔离。

### 记忆提取与管理

```bash
notalone-extract-memory --contact-id '...'   # 自动全量/增量；中断重跑跳过已提取部分
notalone-task-worker --contact-id '...'      # 处理一个后台任务：parse → normalize → extract_memory → index → verify
notalone-memory-add --contact-id '...' --category taboo --text '...'
notalone-memory-add --category recent_state --text '我下周出差'   # owner 级自我记忆
notalone-memory-list --contact-id '...'
notalone-memory-delete --contact-id '...' --memory-id '...'
notalone-task-cleanup                        # 删除超过 90 天的终态任务元数据
```

提取候选先经证据契约与逐条来源语义核验：支持才继续原采纳门，证据不足留待确认，无支持拒绝，未核验不能自动入库。核验不改写正文、主体、来源或有效期；返回片段必须是候选来源中的真实原文，并包含主消息。之后仍执行置信度与风险门槛（低于 0.7 或带敏感/未知风险留待定）、删除指纹和写入裁决，达标者自动采纳、标记 `auto` 并可撤销。生产 CLI／Worker 默认用既有模型每窗口至多增加一次核验，单批最多 60 条；提取与核验各有无正文台账。网络或模型不可用时不推进该批水位；非法结构输出按 ADR-029 连续三次后记录可见跳过并推进，未跳过前不推进。Worker 模型或网络暂时失败最多自动重试 3 次并续期步骤租约，进程中断后重跑从未完成步骤继续，无任务时输出 `status=idle`。`index -> verify` 按确定性代码维护联系人记忆目录（分类、主题提示和 memory_id 引用，最多 20 个主题），不复制正文。手动录入标记 `manual`，支持联系人级与 owner 级。所有命令输出只含状态、计数和元数据，不含聊天正文或模型完整输入输出。目标流程见 ADR-014、ADR-015、ADR-018、ADR-033。

记忆管理页中的候选、联系人记忆和本人记忆均展示来源聊天时间、保存／录入时间，
以及存在的生效／失效时间。来源跨多条消息时显示日期范围，缺失或无法核实的时间
明确标为未知或不完整；历史已完成操作也保留来源日期。已有资料直接从原来源取得
时间，无需重新提取。来源日期表示当时说过，不代表事件恰在当天发生，也不保证旧状态
今天仍成立。候选回复同时读取这些时间，并保存到本次依据快照供回看。

模型置信度表示模型对提取结果的把握，不等于实测准确率；来源支持也不证明现实真伪。旧记忆不自动重提取或补认证。

### 检索评测

只使用合成联系人、消息和来源，不读取真实聊天、不写生产库：

```bash
notalone-retrieval-evaluate            # 内存契约评测
notalone-retrieval-evaluate --json
python -m unittest tests.integration.persistence.test_retrieval_evaluation   # PostgreSQL SQL/全文路径
```

评测覆盖同义表达、确切短语、时间条件、无结果、冲突和跨联系人隔离，记录空结果率、降级率、Top-K 命中、引用纠错率、候选拒绝率、延迟、Token 和 Tool 次数；没有匿名运行观察值时引用纠错率与候选拒绝率显示为 `N/A`。向量候选当前不启用；只有持续检索异常、真实反馈、provider 配置和隐私评审同时满足才进入后续决策，SQL/全文路径仍是唯一生产检索路径。

### 记忆召回评测

```bash
python -m unittest tests.unit.retrieval.test_recall_evaluation
```

109 条合成中文用例覆盖直述、改写、无关拒绝、跨联系人隔离、失效与删除、双预算和排序七个维度；评测装配真实评分器与真实回复上下文组装，不连接数据库、不调用模型、不需要凭据，门槛作为常规测试断言。结果与常量标定见 [`docs/memory-recall-evaluation-baseline.md`](docs/memory-recall-evaluation-baseline.md)。

### 记忆提取准确率评测

```bash
python -m notalone.memory_extraction.evaluation  # 默认跳过，退出码 2
# 专用 NOTALONE_EVALUATION_API_KEY 由 shell 安全注入，不写入命令历史
python -m notalone.memory_extraction.evaluation --dimension subject
python -m notalone.memory_extraction.evaluation --thinking  # 同一模型的思考模式对照，默认关闭
python -m notalone.memory_extraction.evaluation --baseline  # 仅合成资料：测原门槛潜在去向
```

评测不读取 `.env` 或真实聊天、不连接数据库、不写入记忆；仅显式提供专用凭据时发送仓库内合成用例。模型名和地址沿用 `NOTALONE_DEEPSEEK_MODEL`、`NOTALONE_DEEPSEEK_BASE_URL`。输出 JSON 行中的模型字段、最终 `auto/pending/none`、期望对比和失败汇总；退出码 0 为全通过，1 为存在失败。也支持重复 `--case` 按用例名选择。

保留旧 120 条七维度用例，另有 15 个独立来源场景的逐命题挑战，其中 6 个为预留变体。
默认评测同时走来源核验，`--baseline` 只对固定仓库合成集合测未经核验的潜在去向，不提供生产绕过入口。
逐候选完整对照允许命题、主体、限定、时间与去向，并检查每条期望命题召回；正确输出不能覆盖额外错误。
自动无支持主张计安全错误，记错人独立计数。旧集合仅部分有严格命题标注，汇总显式列出语义覆盖；
未标注用例不能证明语义维度达标。同义正则是受控测试 oracle，未匹配结果仍需核对原文，不代表通用语义证明。
`auto` 表示通过正式采纳门的路径，评测不执行存储去重或写入裁决；不能从有限合成结果推断真实聊天准确率。

独立方法复刻实验提供现有方式、叙事后提取、来源时间精修和组合四条路径：

```bash
python -m notalone.memory_extraction.replica_experiment --split all --repetitions 2 --output-dir /tmp/new-synthetic-output
```

仍需显式专用评测凭据，只处理 24 个固定合成场景，不挂接生产或写入记忆。独占保留首次输出，隐藏方法后按中文 gold 逐项复核，语义、时间、漏提及调用成本分别评分；运行完成不等于语义达标。[2026-10-02 实验报告](docs/memory-method-replication-experiment-20261002.md)记录了局部收益和残留错误，当前没有替换默认提取。

主体与事实状态的后续迭代使用两组独立合成场景、固定正负候选及自然提取对照；保留较小的提示词修正，不引入叙事阶段或放宽采纳门槛。局部收益与未解决错判见 [第一轮迭代报告](docs/memory-subject-state-iteration-20261002.md)，真实聊天验收对照只保存在本机私有目录。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试只使用合成数据，不读取 `chat_exports/` 中的私人资料。PostgreSQL 集成测试默认使用本地 `notalone_test` 库，也可用 `NOTALONE_TEST_DATABASE_URL` 指定其他以 `_test` 结尾的隔离库；每个用例使用随机 owner 并只清理自己的合成数据，测试拒绝连接名称不以 `_test` 结尾的数据库。

## 进一步阅读

- [CONTEXT.md](CONTEXT.md)：统一领域词汇
- [architecture/](architecture/README.md)：现行规格、设计草案与 ADR 索引
- [docs/agents/](docs/agents/)：工程、领域与任务工作流
- [website/](website/README.md)：产品官网（本地预览与部署）
