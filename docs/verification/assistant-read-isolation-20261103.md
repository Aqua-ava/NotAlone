# 助手读取与 Skill 核验队列隔离验证

日期：2026-11-03。决策见 [ADR-160](../../architecture/adr/160-assistant-read-and-skill-worker-isolation.md)。修复起点包含前台只读底座 ADR-159；同一工作区其他会话另合入历史轮转与记忆调度优化，本记录不将所有性能改善归因于本次改动。

## 改动及原因

助手打开的删除状态、目录、讨论和候选回看改用专用只读 SQLite Worker，不再进入后台写者队列；保留同一数据库和运行租约。正文读取前后比较业务范围、来源及版本，并登记删除持有者。失效结果丢弃；连接关闭失败必须保留责任并重试，不能误报删除或退出完成。生成、修改及最终提交仍由唯一写者复验。

Skill 原生目录核验放到独立只读文件 Worker，保留原字节、身份、资源、预算和提交资格。异步等待不会占住 HTTP 宿主；取消和关闭不产生迟到写入，也不把取消误写为 Skill 文件失效。并发刷新合并，取消任务收到线程确认前继续占用 32 项额度。

增加动作排队／执行诊断，只保留 64 项内部计时及 60 秒内至多 3 项状态摘要。主线程投递至 Worker 开始包含入站 IPC 和排队；Worker 开始至完成是执行时间，`totalMs` 截止 Worker 回复前，不含返程序列化、IPC 或主线程分派。原 15 秒执行预算保持。实际状态响应最大 1558 字节，低于桌面 4096 字节预算。

## 相同合成负载对照

- **独立助手读取**：固定生产 SQLite 动作，在写者被共享原子栅栏持续占用时，旧完整读取链无法在 750 ms 内完成；新删除状态→目录→正文→候选查看／状态完整 HTTP 链最终一轮 38.17 ms，完成时写者仍未释放。这是隔离回归，不作为常规延迟承诺。
- **Skill 文件慢检查**：同一 800 ms 延迟原生读取场景，原 HTTP 缓存状态等约 778 ms；移入 Worker 后最终一轮为 1.9 ms，即可并发响应。测试没有调用真实模型。
- **覆盖状态批次**：同一实际合成 SQLite 库，64 位已确认联系人各 256 条消息，共 16384 条；批次 1／4／16 交替执行五轮，不舍弃慢轮。下表总耗时含调度，但单动作是生产处理器内部计时，不含 BEGIN／COMMIT 固定开销。

| 每批联系人 | 每轮动作数 | 总耗时中位数 | 每轮最大单动作中位数 | 全部轮次单动作峰值 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 64 | 86.49 ms | 1.88 ms | 2.29 ms |
| 4 | 16 | 82.68 ms | 5.62 ms | 14.37 ms |
| 16 | 4 | 81.18 ms | 19.72 ms | 22.89 ms |

选择每批 4 人：相对 16 人，连续占用中位数减少 71.5%，总耗时增加约 1.9%，动作数增至四倍。正式 `readStatusCoverages` 另外五轮确认每轮 16 个动作、每批不超过 4 人；总耗时中位数 78.86 ms，最大动作中位数 5.51 ms。公平性测试断言批间可插队、撤销过滤、结果顺序及联系人逐项对应，不断言单条 SQL 的固定时长上界。

## 实际开发后台复测

复用现有 `pnpm run dev`，不重启、不清缓存。通过桌面生产 `JsonClient → readAssistantSession → readSqliteDiscussion` 读取；切换组另含 `currentAssistantSession` 的删除状态及目录解析。已知会话组与原反证匹配同一两条发言、1030 字节投影，每次仅在内存核对结果一致；不持久化正文、身份或散列。连接已被状态／目录发现预热，因此不称为首次连接数据。

| 分组 | 次数／成功 | 中位数 | 本批 P95 | 最大值 |
| --- | ---: | ---: | ---: | ---: |
| 原实际后台反证：已知会话、全部连接 | 41／41 | 57.623 ms | 3669.008 ms | 4199.684 ms |
| 原反证中的复用连接子组 | 40／40 | 49.763 ms | 1551.620 ms | 3695.539 ms |
| 新版暖连接连续读取：已知同一会话 | 40／40 | 0.814 ms | 1.402 ms | 1.785 ms |
| 新版暖连接连续读取：解析后切换 A/B | 20／20 | 1.759 ms | 2.883 ms | 3.206 ms |
| 新版约 32 秒分散采样：已知同一会话 | 44／44 | 1.369 ms | 1.866 ms | 3.475 ms |
| 新版约 32 秒分散采样：解析后切换 A/B | 20／20 | 2.882 ms | 4.171 ms | 4.209 ms |

原数据见[扩大复测反证](assistant-discussion-latency-recheck-20261103.md)：41 次中有 1 次新连接、40 次复用，不能直接把全部连接组当作暖连接组；复用子组也存在秒级等待。新两批各自后台 PID 前后一致、无中断，不拼接为一个分布。分散采样顺序交错，前一请求完成后间隔 500 ms，总跨度 31788.49 ms；64 次读取前后均有写者动作执行且队列非空，最高 6 项未决、5 项等待。130 次状态观测主要执行 `identity.directory`（125 次），其余为覆盖、聊天读取及记忆事件。可确认本批助手读取已与忙碌写者分开排队。

后台仍存在长动作和排队：本批可见 `identity.directory` 执行约 672 ms，后续动作排队约 1388 ms；隔离没有消除全部后台 SQL 耗时。两个状态快照之间可能完成／开始其他任务，不能声称整个读取期间同一 SQL 始终执行。

中位数在偶数样本时取中间两项均值；P95 使用 nearest-rank，仅描述本批。首次连接、长期运行、超大讨论、完整 Electron IPC／绘制及模型生成时间未由上表证明；不得将 345 ms、首次连接、单正文与多步解析混作同一口径。所有逐样本及覆盖批次数据见[脱敏数据](assistant-read-isolation-samples-20261103.json)，包含发现阶段和所有慢值。

## 自动验证与实际交互

使用 Node 24；原生读取仍用仓库现有受控读者，没有发布构建。

- 助手／删除／关闭／正式 profile：`node --test test/sqlite-assistant-read.test.mjs test/sqlite-readonly.test.mjs test/sqlite-deletion.test.mjs test/sqlite-host-close.test.mjs test/sqlite-discussion-host.test.mjs test/sqlite-reply-candidates-profile.test.mjs test/sqlite-discussion-integration.test.mjs`，74 项通过。新增竞态及关闭失败均先红后绿；独立审查复核了退休连接关闭重试、owner/contact/source 失效及 Skill 取消洪泛修复。
- 存储计时及只读：`node --test test/sqlite-storage-timing.test.mjs test/sqlite-readonly.test.mjs`，12 项通过，包含累计排队超过 15 秒仍可完成、单动作超时、Worker error/exit 和正常关闭。
- 状态公平性及 HTTP：`node --test test/history-status-fairness.test.mjs test/sqlite-history-http.test.mjs`，12 项通过。
- Skill：`node --test --test-concurrency=2 test/sqlite-skill-async-lifecycle.test.mjs test/sqlite-skill-nonblocking-profile.test.mjs test/sqlite-skills.test.mjs test/sqlite-reply-skill-loop.test.mjs`，49 项通过；另复用已通过的原生文件安全与根迁移验证。覆盖关闭、断连取消、共享刷新、根身份替换和真实队列额度；慢原生核验的正式 profile 并发响应通过。
- `pnpm --dir backend-ts run typecheck`、`pnpm --dir desktop run typecheck`、`git diff --check` 通过。

Computer Use 复用真实开发 App，打开输入小窗并选择已有联系人，确认讨论加载完成、没有残留“正在恢复／重新读取”错误、输入控件可编辑；填入临时合成草稿后确认“帮我表达”启用，再清空确认恢复。没有点击生成或外部发送。期间一次开发热更新导致控件暂不可用；恢复后重新操作成功，该中断不计入稳定 PID 性能批次。没有保存私人截图，也没有把界面操作换算成毫秒统计。

数据影响：不迁移、不删除真实聊天或记忆，不扩大读取授权。实际采样只读既有讨论及无正文状态；只有验收临时草稿写入本地控件，已清空。本任务未主动发起真实模型请求、微信消息发送、打包、发布或推送，现有后台按原设置继续运行。合成数据库与自有测试进程均清理，保留现有开发实例。
