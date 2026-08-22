# NotAlone

NotAlone 是面向具体联系人的中文关系感知回复助手。当前可执行产品代码支持微信单联系人
JSONL 的只读预览，以及经过联系人确认后的 PostgreSQL 正式导入。

## 开发环境

所有 Python 命令必须在 Conda 环境 `NotAlone` 中运行：

```bash
conda activate NotAlone
python -m pip install -e .
```

## 候选回复纵切

仓库现在包含内部开发用的候选回复纵切：调用者只经过
`ReplyGenerator.generate(GenerateReply) -> ReplyOutcome`，其中 `GenerateReply` 统一支持
`ReplyToMessage`（目标消息 + 用户确认的表达方向）和 `RewriteDraft`（用户原句 + 可选的
一次性改写要求）。改写要求只作用于当前请求；没有明确背景要求时不带入长期关系记忆。
`notalone.skills` 作为独立 Module 提供联系人范围内的不可变策略目录；回复 adapter 使用
LangChain `create_agent` 和 Deep Agents `SkillsMiddleware` 按需读取至多一个 Skill。
调用 Reply 前必须由 `CandidateReplyFlow` 验证当前会话，并把
`VerifiedConversationScope` 作为 `ReplyGenerator.generate(..., verified_scope=...)` 的必填证明。

当前验证只使用合成数据、scripted fake model 和 PostgreSQL/内存 adapter。PostgreSQL
SkillPort 已接入迁移 008，并按 owner/contact 范围只读当前 Skill 目录和不可变版本；真实模型
供应商、出站台账、产品 CLI 或 UI 尚未实现，因此这还不是可供真实联系人使用的端到端回复
功能；代码不存在发送消息 Tool。PostgreSQL Retrieval 已接入消息查询，只读取当前联系人范围
内 active 来源的规范化消息，支持关键词、目标消息优先和媒体占位；关系记忆的 PostgreSQL
查询已接入 009 迁移，只返回 active、有效期内且仍有有效来源的 `confirmed_memory`；记忆目录、
自动提取和来源删除级联仍未实现。

ReplyStore 当前收敛为请求/结果持久化边界：按已验证联系人范围和幂等键处理重放、冲突、
处理中、失败重试、租约过期和用户显式继续候选。`ReplyGenerator` 必须显式注入
`ReplyContext`；Store 不再准备上下文、不读取 Memory、不识别联系人，也不继承“上一轮
未发送候选”。当前实现包含进程内 adapter 和 PostgreSQL adapter；后者只保存请求、上下文
快照、候选、引用与 Skill 使用摘要，不准备上下文、不读取 Memory，也不发送外部消息。

已确认桌面会话绑定已经有 PostgreSQL 迁移 006 和持久化 `ConversationPort`：它按
`owner_id + contact_id` 创建、读取和撤销绑定，并在进程重建后重新验证 active 绑定。当前
真实桌面观察、OCR 和前台同步仍未接入；`ConversationObservation` 仍由上层适配器提供。

外部模型调用的出站台账已有 PostgreSQL 迁移 010、台账 port 和进程内/PostgreSQL adapter：
每条记录只含时间、供应商标识、模型名、联系人范围、用量与结果状态，不含正文，按 owner
隔离查询，不随联系人或来源删除级联清除。真实模型供应商接入与台账接线尚未实现。

## 导入预览

```bash
notalone-ingest-preview chat_exports/example.jsonl
```

预览会校验完整文件、识别唯一联系人并统计消息类型。输入文件损坏、混有多个联系人或
消息字段不符合契约时，命令以非零状态退出；错误信息只包含行号和字段，不显示消息正文。
单个 JSONL 文件上限为 64 MiB、消息记录上限为 500,000 条；超限文件会被拒绝处理。
默认输出还会隐藏文件名、联系人 ID 和展示名称。需要在当前终端人工核对时，显式运行：

```bash
notalone-ingest-preview --show-identifiers chat_exports/example.jsonl
```

该选项只改变当前终端的显示，不会写数据库或保存日志。

## 正式导入

正式导入前，必须先运行预览并人工选择一个已有 NotAlone 联系人，或明确创建一个新联系人。
数据库中还必须已经存在对应的 `owner`；命令不会从聊天记录推断或创建 owner。

数据库连接串和受控运行身份只通过环境变量提供，不写入仓库：

```bash
export NOTALONE_DATABASE_URL='postgresql:///notalone_dev'
export NOTALONE_OWNER_ID='00000000-0000-0000-0000-000000000000'
notalone-ingest chat_exports/example.jsonl \
  --contact-id '11111111-1111-1111-1111-111111111111'
```

首次导入且还没有联系人时，改用：

```bash
notalone-ingest chat_exports/example.jsonl \
  --new-contact-name '联系人展示名称'
```

`--contact-id` 与 `--new-contact-name` 必须二选一。前者是 NotAlone 生成的内部联系人 UUID，
不是微信 `sender_wxid`，并写入 `manual_select` 确认；后者创建内部联系人 UUID，并写入
`manual_create` 确认。命令会再次完整校验文件，把识别出的微信身份与用户确认的联系人绑定。
`NOTALONE_OWNER_ID` 由受控运行环境注入，不属于联系人确认参数。
同一 `owner_id + contact_id + SHA-256` 的 active 来源重复执行时不会重复写入消息。联系人、
渠道身份、来源、确认记录和全部消息在同一事务中写入，任何一步失败都会整体回滚。终端输出
只包含导入状态和消息数量，不输出聊天正文、联系人 ID、owner ID、文件 SHA 或数据库连接串。

不同 SHA 文件若与该联系人已有来源复用 `id.local_id`，命令会拒绝整批导入；它不会
自动合并或改写旧消息的权威来源。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试只使用合成数据，不读取 `chat_exports/` 中的私人资料。

PostgreSQL 集成测试默认使用本地 `notalone_test` 数据库，也可以通过
`NOTALONE_TEST_DATABASE_URL` 指定其他名称以 `_test` 结尾的隔离测试库。每个用例使用
随机 owner 并只清理自己的合成数据；测试拒绝连接名称不以 `_test` 结尾的数据库。
