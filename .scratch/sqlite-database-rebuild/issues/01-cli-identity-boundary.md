# 核验微信消息稳定身份与读取边界

Triage: ready-for-agent
State: resolved
Type: research
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: none

## Question

锁定与实际使用的微信 CLI 及只读补丁，对账号／会话／消息身份、缺失时间、重复 local_id、不透明游标和历史截断分别能证明什么？哪些不能证明，数据库必须增加哪些适配器前置合同？

## 已有输入

- [message-storage-draft.md](../message-storage-draft.md)
- [sync-incremental-normalize.ts](../../../backend-ts/src/sync/sync-incremental-normalize.ts)
- [sync-incremental-store.ts](../../../backend-ts/src/sync/sync-incremental-store.ts)
- [readonly-cli.patch](../../../desktop/wechat-patches/readonly-cli.patch)

## 完成条件

基于锁定源码、官方说明和现有代码形成事实与缺口清单；不读取私人数据，不执行媒体或聊天读取；明确消息去重键及清空边界的可证明程度，供后续设计使用。

## Answer

事实调查完成，见[研究笔记](../../../research/sqlite-wechat-message-identity.md)。

- 锁定 CLI 2.0.1-rc.5 固定提交与本项目只读／历史补丁已核对；未读取实际桌面配置或运行二进制，实际部署来源仍未核验。
- 当前消息输出缺少分片／排序身份；cursor 以 local_id 找锚点，多个匹配时取首条，不能证明重复标识下的无歧义续读。现有去重组合和缺时哨兵值也没有获得完整唯一性证明。
- 当前历史模式不提供清空瞬间快照边界；秒级时间、最大 local_id 和已捕获消息抑制不能证明已确认的清空目标。
- 后续消息与删除设计必须保留原始隔离记录，分别定义身份、位置、范围代次、覆盖与处理状态，并补足适配器合同。

验证：静态阅读仓库与上游固定提交、检查本地引用和文档格式；没有运行 App、CLI、真实数据库或合成测试，不以研究结论冒充端到端验收。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。

- 2026-10-28：研究结果已写入 Answer，保留实际部署版本与真实微信约束尚未验证的限制；只关闭事实调查，不关闭后续关系模型或清空算法决定。
