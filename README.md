# NotAlone

NotAlone 是面向用户真实联系人的中文关系感知回复助手。用户确认联系人与桌面会话后，导入历史聊天或开启前台增量同步；系统检索同一联系人的关系资料并生成候选回复，由用户选择、修改并亲自发送，产品不会代发消息。

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

脚本按顺序完成：检查依赖（macOS / Homebrew / conda / PostgreSQL / swiftc）→ 创建 `NotAlone` conda 环境并 `pip install -e .` → 启动本地 PostgreSQL 并创建 `notalone_dev` → 按文件名顺序应用全部 `database/migrations/*.sql` → 生成只含数据库连接的受控 `.env`（0600）→ 构建 macOS App 与前台同步探针。已存在的环境、数据库、迁移与 `.env` 会被跳过或保留；失败时输出引导，不留下半初始化状态。

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

```bash
export NOTALONE_DATABASE_URL='postgresql:///notalone_dev'
export NOTALONE_OWNER_ID='00000000-0000-0000-0000-000000000000'

notalone-front-sync enable      # 手动开启 CLI 后台增量同步
notalone-front-sync contacts    # 列出 CLI 可见私聊，供绑定确认选择
notalone-front-sync confirm-binding --contact-id '...' --locator 'wxid...'
notalone-front-sync status      # 执行一次双通道检查，输出 CLI 后台与前台 OCR 状态
notalone-front-sync disable     # 手动关闭；关闭窗口内消息重新开启后只前移水位、不写入
```

绑定只接受 CLI 返回的私聊会话定位标识，不用昵称猜测联系人；新会话默认创建本地联系人，已绑定会话不会静默改绑。输出只含状态、计数、展示名称与候选标识，不含消息正文。CLI 全局流不可用时退化为有界一次性轮询。已有安装需重跑 `zsh scripts/install.sh` 以补齐增量迁移（含 026、027）。

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

提取候选经证据契约校验、置信度与风险门槛（低于 0.7 或带敏感/未知风险留待定）、删除指纹和写入裁决后，达标者自动采纳、标记 `auto` 并可撤销；外部模型调用按三态写入出站台账（只含元数据不含正文）。Worker 模型或网络暂时失败最多自动重试 3 次并续期步骤租约，进程中断后重跑从未完成步骤继续，无任务时输出 `status=idle`。`index -> verify` 按确定性代码维护联系人记忆目录（分类、主题提示和 memory_id 引用，最多 20 个主题），不复制正文。手动录入标记 `manual`，支持联系人级与 owner 级。所有命令输出只含状态、计数和元数据，不含聊天正文或模型完整输入输出。目标流程见 ADR-014、ADR-015、ADR-018。

### 检索评测

只使用合成联系人、消息和来源，不读取真实聊天、不写生产库：

```bash
notalone-retrieval-evaluate            # 内存契约评测
notalone-retrieval-evaluate --json
python -m unittest tests.integration.persistence.test_retrieval_evaluation   # PostgreSQL SQL/全文路径
```

评测覆盖同义表达、确切短语、时间条件、无结果、冲突和跨联系人隔离，记录空结果率、降级率、Top-K 命中、引用纠错率、候选拒绝率、延迟、Token 和 Tool 次数；没有匿名运行观察值时引用纠错率与候选拒绝率显示为 `N/A`。向量候选当前不启用；只有持续检索异常、真实反馈、provider 配置和隐私评审同时满足才进入后续决策，SQL/全文路径仍是唯一生产检索路径。

### 记忆提取准确率评测

```bash
python -m notalone.memory_extraction.evaluation  # 默认跳过，退出码 2
# 专用 NOTALONE_EVALUATION_API_KEY 由 shell 安全注入，不写入命令历史
python -m notalone.memory_extraction.evaluation --dimension subject
```

评测不读取 `.env` 或真实聊天、不连接数据库、不写入记忆；仅显式提供专用凭据时发送仓库内合成用例。模型名和地址沿用 `NOTALONE_DEEPSEEK_MODEL`、`NOTALONE_DEEPSEEK_BASE_URL`。输出 JSON 行中的模型字段、最终 `auto/pending/none`、期望对比和失败汇总；退出码 0 为全通过，1 为存在失败。也支持重复 `--case` 按用例名选择。

现有 24 条按 `subject`（主体）、`truth_intent`（真假与意图）、`time`（时间）、`reported`（转述）归类；后续票补齐七维度。`auto` 表示通过正式语用、置信度及风险门槛的路径，未执行存储去重或写入裁决。原型中的 `confirmable` 只是语用结果；贷款申请迁入后期望为 `pending`，并单独检查本人已发生事实标签。多个候选按最强去向比较，主体与可选标签要求所有候选符合；模型失败或外壳拒绝不能计为通过。当前检查不自动判定文本语义保真或取消行程是否改写正确，不能据此宣称维度达标。

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
