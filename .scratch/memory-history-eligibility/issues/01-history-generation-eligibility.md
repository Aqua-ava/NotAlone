# 记忆退役原因与生成入口复验

Triage: ready-for-agent
State: resolved

规格：[spec](../spec.md)。测试接口与行为已由用户确认。

## 完成条件

联系人与本人均具备两类修改；错误和未知旧版不能通过已保存派生内容进入生成；
真实变化历史仍可用；审计和删除边界不变；文档、相关验证与本地提交完成。

## Answer

已实现联系人与本人两类修改及历史生成资格；文档见 [ADR-071](../../../architecture/adr/071-memory-retirement-and-generation-eligibility.md)。

- `error_correction` 与 `unknown` 失效旧版仅供审计；`state_changed` 旧版仍须满足来源与历史标注要求。旧调用默认纠错，不根据版本链猜测原因。
- 资料读取、概览、L2/L3、候选续写、助手讨论、准备/恢复及表达样本统一复验；表达样本递归追溯来源候选，防止 A→样本→B 传播旧错误，并防循环。来源候选已不存在时保守禁用样本生成。
- 旧候选仍可回看并提示重新生成。纠错不删除原始聊天；真实删除沿既有清理闭包处理。`retired_at` 不冒充事实变化时间。
- 081 为退役原因与记录时间；084 调整审计触发器，均保留历史未知默认值。081 已由并行提交纳入，未修改已登记文件。仅对自行创建的隔离 PostgreSQL 测试库迁移，结束删除该测试库；未操作业务库账本或资料。

验证（以下分组存在重叠，不作总和）：

- `python -m unittest tests.integration.server.test_memory_retirement_http tests.integration.persistence.test_memory_retirement tests.unit.application.test_memory_service tests.unit.memory.test_memory_store -v`：在完整迁移后的隔离库，26 项通过。
- 生成与审计目标回归12项通过，含间接表达样本续写阻断、讨论剔除、联系人/本人L2、准备恢复、纠错竞态及来源删除；回复单元418项通过。
- 桌面 `npm run typecheck` 通过；相关 IPC/React/警示测试72项通过，控制器9项通过；测试等待修复使用明确异步信号，不用延时。
- 独立 Standards 审查无阻断问题；Spec 审查发现的表达样本传播 P1 已红→绿修复并复审关闭。`git diff --check` 通过。

剩余验证限制：

- 实际复用 `npm run dev`，通过 Computer Use 点击 App 重试连接；现有数据库“迁移账本或基线发生漂移”，联系人与本人资料页不能操作。因此真实 App 完整功能验收未通过，未擅自改业务账本、打包或调用真实模型。
- 扩展纠错导入回归60项中50通过、10失败；失败发生在初次导入，旧合成 fixture 拒绝并行工作引入的 DirectExtractionRuntime 协议，尚未进入本任务纠错步骤。更广生成回归也遇到旧模型调用次数/超时假设差异；本任务目标回归已单独复验，不宣称整套测试全绿。
- 只创建本任务本地提交，不推送。未生成私人测试联系人、保存桌面截图或发送外部消息；未新建常驻 App 进程。
