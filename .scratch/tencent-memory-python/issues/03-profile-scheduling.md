# 画像与自动调度
Triage: ready-for-agent
State: resolved

## What to build
变化场景增量维护画像，按消息量/空闲触发并可靠恢复。仅参考腾讯源码，在现有 Python 后端自行实现。

## Blocked by
02

## Acceptance criteria
- [x] 正式入口完整行为实现
- [x] 用户确认接口边界的回归测试先红后绿
- [x] 腾讯源码对应关系与产品适配差异记录
- [x] 来源、删除、人工修正及联系人隔离不退化

## Answer

已集成变化场景与既有画像工具维护、持久阈值/空闲调度和启动补扫。来源映射见 `../source-map-profile.md` 与 `../source-map-scheduling.md`。画像5项HTTP及调度8项HTTP、观察验收入口1项边界测试通过；旧预算与失败恢复2项通过。来源删除、撤销绑定、纠错保护、重复输入与停机均有回归。正式模型与开发App验收继续由04执行，不以这些合成测试宣称整链质量。
