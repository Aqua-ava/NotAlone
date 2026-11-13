# 03 出现来源不明的无前缀 run

Triage: needs-triage
State: open

## 现象
run `b8a5dade`（联系人 C）的 `start_request_key` 是不带前缀的 UUID，对应旧的全局 `start` 路径（`POST /api/memory-processing/runs`），与 A 的 run 同一秒创建。本会话没有调用该接口。

## 待查
- 是谁发起：开发实例窗口、调度器还是其他入口。
- 该 run 现为 `incomplete`，任务 `awaiting_decision`，提取/裁决/关系核验各成功，需确认待决定原因。

## Comments
