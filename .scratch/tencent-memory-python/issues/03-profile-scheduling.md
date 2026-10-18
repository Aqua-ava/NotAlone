# 画像与自动调度
Triage: ready-for-agent
State: open

## What to build
变化场景增量维护画像，按消息量/空闲触发并可靠恢复。仅参考腾讯源码，在现有 Python 后端自行实现。

## Blocked by
02

## Acceptance criteria
- [ ] 正式入口完整行为实现
- [ ] 用户确认接口边界的回归测试先红后绿
- [ ] 腾讯源码对应关系与产品适配差异记录
- [ ] 来源、删除、人工修正及联系人隔离不退化
