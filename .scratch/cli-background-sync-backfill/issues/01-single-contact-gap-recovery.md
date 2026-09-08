# 01 — 已确认会话缺口检测与单联系人补齐

**What to build:** 用户重新开启同步、App 重启恢复或执行立即检查后，已确认且仍为 active 的一对一会话能够从最后可靠位置检测可读取缺口，按批次补齐文字消息，并向用户报告覆盖状态与进度。

**Blocked by:** None — can start immediately

Triage: ready-for-agent
State: resolved

- [x] 只处理已确认且仍为 active 的联系人绑定；不追溯绑定 baseline 之前的历史，不读取同步关闭期间的消息直到重新开启。
- [x] 每个成功批次在同一成功边界内保存来源记录、规范消息和联系人独立游标；部分失败不得把补齐标记为完成。
- [x] 覆盖状态能区分发现缺口、补齐中、补齐完成、补齐失败和无法确认完整，并返回不含聊天正文的计数、游标和失败原因。
- [x] 合成 CLI、持久化和 HTTP 测试覆盖关闭后恢复读取、空缺口和失败不虚报完成。

## Answer

已实现 active 已确认绑定的重启/重新开启缺口检测、按 baseline 或最后可靠游标读取，并以来源、规范消息和游标同一事务成功为完成边界。补齐状态持久化 `gap_detected`、`backfilling`、`complete`、`failed`、`incomplete` 和计数/游标元数据，HTTP 状态不返回聊天正文。

验证：`python -m unittest discover -s tests -q`（753 tests OK）；相关 HTTP/持久化合成测试通过。真实微信授权链路仍需用户执行人工作业验收。
