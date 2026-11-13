# CLI 从最早点分页读取

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，当前 `tail` 在没有 cursor 时只返回最新 N 条，无法读取完整历史。本票在 pinned 只读 CLI 补丁中增加从最早点开始的有序分页与不透明游标续读，并让 adapter 暴露历史分页结果；实时与增量的现有语义保持不变。

## 验收

- [x] 同一会话可用历史游标从最早一页连续读到最新；`has_more` 与游标语义支持中断重读，不跳过、不重复。
- [x] `--limit` 被真正传递给 CLI 且有明确边界；分页不依赖单一全局事务。
- [x] 等时间戳消息的页内与跨页顺序稳定，沿用现有提交顺序与消息身份规则；非文字事件不阻塞后续文字页。
- [x] 自定义 `username`（非 `wxid_`）的历史分页可用，且与 01 的身份规则一致。
- [x] 补丁保持 `--strict-read-only`；scripted CLI 与真实 pinned 构建分别验证，adapter 测试通过。

## Comments

2026-10-23：实现完成。CLI 新增 `tail <talker> --history --limit N [--cursor C]`：首页从本机可读最早消息按 `sort_seq ASC, local_id ASC` 返回一页，`has_more` 表示还有更晚消息；响应游标为既有 `local_id:<n>` 形式，adapter 只当作不透明字符串原样回传。历史页与增量页共用同一 `after_message` 边界（`sort_seq/local_id`，与上游 timeline 锚点规则一致），因此追平后可直接把最后游标交给不带 `--history` 的 `tail` 接续实时读取。无 cursor 且不带 `--history` 时仍返回最新 N 条且 `has_more=false`，有 cursor 的增量读取仍为升序最旧页。

`--history` 与 `--follow`、`--since-time`/`--since`/`--after`/`--since-local-id`、`--mode sessions` 的组合会被拒绝；`limit` 沿用 read_events schema 的 1..1000 边界。adapter 新增 `tail(..., history=True)`，要求显式 1..1000 的 `limit`，校验响应 `query.history=true`，并继续通过 `TailResult.has_more` 暴露后续页；`--strict-read-only` 始终传入。

两轴评审：Standards 初审 7 项判断，采纳并修复 CLI 帮助文案语言、Go 测试重复 harness、Python limit 错误消息硬编码三处；其余（跨层边界校验、测试 envelope 重复、参数 Data Clump、`history` 命名）按既有内部防线或上游协议命名保留。Spec 初审指出跨页并列组与多分片分页未被用例覆盖、`--history --jsonl` 仍会丢弃分页 envelope；已把合成消息拆到 `message_0.db`/`message_1.db`，让 `sort_seq=500` 的并列组跨越页边界重读，并拒绝 `--history` 与 `--jsonl`/`--follow` 的组合。复审两轴均为 0 项剩余阻塞问题。

## Answer

实现后的行为：

- `tail custom_history_42 --history --limit 3` 返回最早 3 条（含非文字事件），`query.history=true`，`has_more=true`，游标 `local_id:3`；带该游标续读返回 4、5、6，再续读返回 7 且 `has_more=false`。消息分布在两个 `message_*.db` 分片，合并排序后仍无跳过、无重复；中断后重复同一游标得到同一页。
- 等 `create_time` 的消息与同 `sort_seq` 消息按现有 `sort_seq/local_id` 顺序跨页稳定；`sort_seq=500` 的 5、6、7 跨越第二、三页边界，仍按 local_id 接续。中间的非文字图片事件只占页内位置并推进游标，不阻塞后续文字页。
- 不带 `--history` 的实时页仍返回最新 3 条（`history=false`、`has_more=false`）；带游标的增量页仍升序返回之后的消息。
- 自定义 `username`（非 `wxid_`）在联系人库存在或缺失时都可分页读取，沿用票 01 的 `username_exact` 身份解析，不要求缓存刷新。
- adapter 的 scripted CLI 用例确认实际 argv 为 `tail wxid_1 --history --limit 2 --include-media-paths false --strict-read-only`，并拒绝缺少 `query.history` 的响应、要求 `has_more` 时游标前进。
- `--history` 与 `--follow`、`--jsonl`、`--since-time`/`--since`/`--after`/`--since-local-id`、`--mode sessions` 的组合均被拒绝；`--limit` 由 read_events schema 与 adapter 双重限制在 1..1000。

验证命令与结果：

- 红：在旧补丁上运行 `go test -run '^TestNotAloneHistoryPagination$' ./cmd/wechat-cli`，失败于 `unknown argument "history" for tool read_events`。
- 绿（锁定 Go 1.26.5、WCDB 2.1.16、重建 CLI）：`NOTALONE_TEST_WCDB=... go test -p 2 -run '^TestNotAlone' ./cmd/wechat-cli` 通过，5 个用例；相关上游 `tail/timeline/cursor` 回归 `-run 'Test(ReadEvents|ReadMessageEventArgs|ChatTimeline|DisplayAndCursor|MessageOrder|SessionEventCursor|TailSchema|SortLiveMessageRows|NotAlone|TimelineEnvelope)'` 通过。
- adapter：`python -m unittest tests.unit.wechat_cli.test_adapter` 39 项通过；`discover -s tests/unit/wechat_cli` 127 项通过；`discover -s tests/unit/front_sync` 233 项通过。
- 打包门禁：`node --test tests/packaging/wechat-cli.test.mjs`（指向重建 CLI）2 项通过。
- 补丁对新 pinned 源 `git apply --check --whitespace=error-all` 通过；仓库内测试文件与构建源副本逐字节一致；补丁与测试文件 sha256 已写入 `desktop/wechat-sources.lock.json`。
- 全量上游 `go test ./cmd/wechat-cli` 仍有 8 个与本票无关的既有失败（ASR/Keychain/图片缓存等），已在未改动的旧补丁上复现，原因是产品补丁强制严格只读；集成分页测试因本机无 PostgreSQL 测试库而跳过。

数据处理影响与剩余风险：只新增只读分页参数与游标语义，不扩大消息、联系人、媒体或发送范围；合成夹具均为匿名数据，未读取真实微信。真实 24 个会话与整包 App 验收留给票 08；本机无完整 Xcode，未运行 `prepare-wechat.mjs` 整包构建。
