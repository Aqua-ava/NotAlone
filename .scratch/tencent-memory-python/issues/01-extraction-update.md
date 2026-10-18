# 提取与自动更新
Triage: ready-for-agent
State: resolved

## What to build
自动提取并通过混合召回和批量裁决新增、跳过、更新、多目标合并，正式路径生效。仅参考腾讯源码，在现有 Python 后端自行实现。

## Blocked by
None

## Acceptance criteria
- [x] 正式入口完整行为实现
- [x] 用户确认接口边界的回归测试先红后绿
- [x] 腾讯源码对应关系与产品适配差异记录
- [x] 来源、删除、人工修正及联系人隔离不退化

## Answer

源码对应见 `../source-map-l1.md`。10项生产HTTP合成回归通过，覆盖单父/多父更新合并、批量候选、skip、越界待处理、人工保护、本人隔离及来源删除；离线真实embedding自检2×512维通过。相关79项旧单测中78通过，`test_adjudication_invalid_output_counts_toward_skip`的旧SimilarMemoryPort缺少list_pending_candidates为既存夹具错误（前轮已记录），本任务未改其旧诊断路径。真实生成模型与桌面整体验收由ticket04继续；本票未调用外部模型、未打包。
