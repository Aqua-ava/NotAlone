# 桌面草稿与可见性轮询

Triage: ready-for-agent
State: resolved
Blocked by: None

## 来源

[统一规格](../spec.md)、统一规格中的两份审计报告及合成复现脚本。

## 职责边界

草稿每键全量联系人状态与双窗口广播、MemoryPage离页仍轮询、Skill不变状态发布。职责为desktop contacts/session与bridge、memory controller/renderer/preload/共享协议、skill-learning；不修改assistant-sessions历史分片、native、backend、package.json默认测试清单。

## 完成条件

身份/删除/断连/迟到响应/切联系人及编辑草稿保持；初读/重入必须权威刷新；不能靠降低资格/失效检查频率优化。对照请求/发布次数与数据量；合并后由05做实际dev App验收。

必须先核当前main、读对应架构与仓库工程规范；先复现再实现，完成目标而非只写计划。每个聊天开始先调用create_goal，不设预算；本issue改claimed，实际完成并写Answer后改resolved。结果写本目录../02-desktop-state-result.md。不直接修改共享root产品代码，不push、不打包、不迁移业务库、不发外部消息。

## Comments

## Answer

已在受管工作树 `desktop-state-opt/NotAlone` 的本地分支 `codex/desktop-state-opt` 实施，产品提交 `9e8f8d9c`、审查修复 `cf08f92f`。草稿事件/确认改为范围小包，记忆页面卸载释放轮询并保留写后复验和重入读取意图，Skill 相同状态跳过发布但保留所有 GET 核验。

最终类型检查通过，相关 Node/React 125/125 通过；100 联系人/100 次输入 JSON 3,711,756→80,856 B；离页 60 轮 GET/发布 60/60→0/0；Skill 稳态 40 发布→0（GET 仍40）。独立双轴审查发现的重入竞态已补回归修复。详见 [结果与边界](../02-desktop-state-result.md) 和 [原始测量](../evidence/02-measurements.json)。

基线已有旧迁移计数、路由夹具及文案断言失败已单例复现，没有降低来源检查或改文案迎合测试；默认测试清单及真实 dev App/微信验收由05统一集成。不 push、不打包、不改业务库、不调用外部模型或发送聊天。

