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

源码对应见 `../source-map-l1.md`。14项生产HTTP合成回归通过，覆盖单父/多父更新合并、批量候选、首批去重、不同时间不得skip、越界待处理、人工保护、本人隔离、来源删除和本机embedding缺失诊断。离线真实embedding自检2×512维通过；相关69项旧单测通过，旧裁决夹具及两项追踪断言已随正式行为更新。更广981项L1单测发现3项既有评测worker的deadline变量遮蔽失败，源码与本任务基线相同，记录在04验收。真实模型和桌面由ticket04继续。
