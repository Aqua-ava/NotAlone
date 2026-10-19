# 统一工作区页面回归适配

Triage: ready-for-agent
State: resolved

规格：[统一表达工作区](../spec.md)。将旧 reply-strategy、understanding-direction、conversation-strategy-entry 页面业务测试迁移到现行双动作入口，只修改测试，不恢复旧产品界面。

## 完成条件

- 空输入建议和非空想法表达直接生成候选；聊天上下文与本人想法分离。
- 保留适用的来源删除、联系人隔离、幂等、迟到结果、候选分组与版本、连续调整断言。
- 移除仅属于已退役探索／确认方向步骤的交互，用现行生成生命周期验证等价边界。
- TypeScript 检查通过，报告需复验的具名页面 case；页面执行与共享夹具由统一串行回归任务协调，禁止争用 Chrome 租约。

## Comments

- 2026-10-19：根据回归失败补充适配14个页面测试文件，分组独占编辑。产品提交为 f9529532。

## Answer

已适配14个页面测试文件：`conversation-strategy.ts`、`understanding-direction.ts`、`reply-strategy-{combination,options,dialogue,clarification,bounded-updates,lifecycle,transition,skills,message-groups,group-boundaries,version-edit-guard,continuation}.ts`。新增统一工作区DOM操作助手，复用真实可见控件，不恢复退役界面。仅测试变化，无生产数据处理变化。

保留的覆盖包括：空输入建议与非空表达、本人想法和聊天背景分离、生成理由、请求幂等、同键输入不可替换、跨联系人迟到结果、新消息只提醒、关闭／切换会话后的生成归属、Skill加载和失效、21来源完整性、未确认资料、来源删除及后续候选继承删除依赖、消息组版本编辑恢复和复制拒绝。退役的是探索选项／暂停／先确认方向及探索专属TTL交互。

2026-10-20执行 `npm run typecheck` 和限定本任务文件的 `git diff --check` 均通过；静态核对发现的证据接口字段、重复定位器、连续修改新增要求确认问题已修正。未启动Chrome、页面runner或开发服务，未声称页面运行通过。

页面复验由统一串行回归任务执行，去重清单：

- conversation-strategy-entry
- understanding-direction
- reply-strategy-combination（含未独立注册的replyStrategyContinuation；组合还依赖assistant-message-opt-in与authentic-expression-typed）
- reply-strategy-invalidation
- reply-strategy-group-boundaries
- reply-strategy-version-edit-guard
- reply-strategy-transition
- reply-strategy-lifecycle
- reply-strategy-skill-invalidation
- reply-strategy-confirmed-clarification

共享Python模型／消息夹具的workspace协议适配由回归任务负责，本提交不包含其改动。页面运行结果及运行中发现的问题在串行回归任务继续跟踪。
