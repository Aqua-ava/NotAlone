# 场景自动整理
Triage: ready-for-agent
State: resolved

## What to build
通过受限文档工具增量维护、合并场景，保持来源与隔离。仅参考腾讯源码，在现有 Python 后端自行实现。

## Blocked by
01

## Acceptance criteria
- [x] 正式入口完整行为实现
- [x] 用户确认接口边界的回归测试先红后绿
- [x] 腾讯源码对应关系与产品适配差异记录
- [x] 来源、删除、人工修正及联系人隔离不退化

## Answer

默认Python受限Markdown工具循环、事务来源回编、物理预算与独立核验无改动回执已完成。源码映射和差异见 `../source-map-l2.md`。真实模型及桌面端到端验收由04统一执行。

验证：7项聊天/HTTP场景工具回归、2项默认装配和7项SDK核验合同共16项通过；旧拆分/合并、重试预算与评测物理额度3项通过。命令在backend目录以工作树绝对PYTHONPATH运行，合成数据库均由finally清理。
