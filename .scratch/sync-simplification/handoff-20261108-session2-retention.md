# 同步减负 06 收尾交接（2026-11-08 第二轮终版）

总背景先读 `handoff-20261108-channel-cluster.md`；本文件为该会话最终权威交接。

## 提交链（工作树 /Users/local-user/Documents/learn/NotAlone-sync-remaining，分支 codex/sync-simplification-remaining，工作树干净）
- `077733bcc` wip1：06 全部改动保全点
- `92855eee5` wip2：guard/prep 套件恢复 f687 断言 + wechat-channel park 恢复 + 保留条目初版
- `7c971d375` fix：守卫租约保留语义 + 删除经保留条目统一排空（guard+prep+channel 三套件首绿）
- `7dc6b491b` wip3：withExclusiveChannel run 回调扩 8 参；synchronize/synchronizeIncremental 基线逐字移植；empty/goal-reuse/parked 断言恢复 f687
- `5523012c5` wip4：收尾重入死锁修复（finally 先宣告工作结束→统一 holder 释放；读 holder 入 releases 清单）+ armGuard 装配即登记保留条目 + 切片停车按当前条目标记 + ensure 复验停车移出回调

## 套件终态（本地复验证据 diagnostics/session2-*）
全绿：channel 44/44（channel 簇"唯一阻塞"收敛）、guard 40/40、source-preparation 7/7、
parked-sync-handoff 6/6、goal-reuse 8/8、empty-revalidation 4/4、cutover-disabled 2/2
残留：shared-process-loss 8/9（余 1 例）；其余增量族见"待决策失败清单"

## 待决策失败清单（wip4 代码下全量 24 例，其中 20 例基线命中故实际余 ~9）
1. shared-process-loss 仅 1 例：期望 `history_source_changed`，新链路围栏为 `history_source_continuity_unverified`（ discontinuity 语义映射，或 f687 分配指针差异，产生的 code 未对齐）
2. `snapshot-follow`（06 版）3 例 + `partition-growth` 2 例：每租约释放断言与保留语义冲突——修复方案或改断言或持保留语义
3. `history-status-recertification` 6 例（全挂）：测试直接写 `history_source_recertification` 表——该表已被 ADR-177 退役删除；此测试族本身即为退役对象，应随 recertify 测试一并退役（06 删除清单未含它，疑似遗漏）
4. `first-history-coordinator` 1 例 + `cutover-retirement` 1 例：宿主状态声明/围栏族，仍属语义映射

## 外部阻塞（与代码无关）
47 库副本两轮回放：手动对 wx-cli 发 `resolve` 一律 `history_source_unverified`；06 版代码在 /tmp/wt-06 复现同样失败。微信进程正常但 CLI 会按要求做 UI 侧介入后重放 `six-copy-sync.mjs`。

## 建议下一步
1. 决策清单第 3 项回收：把 history-status-recertification 测试随 ADR-177 退役，或者保留为负对照
2. 收敛冲突项 1/2：核心问题是"测试确识旧模型语义看新的保留模型"两个 model 选择是否均需统一投射
3. 47 库副本回放 + 隔离开发 App 重跑会话，以及全量对照
4. closeout 文档 + 按主题提交 + 06 resolved；合并 main 暂缓

## 关键限制
真实库只读；禁打包；禁发微信消息；dev:status 先查复用；等待操作有界；合并前先备份 before-migration-47；合并后核对 dev 重启 + 库 47 + 16 位 proof ok + 消息数不变。
