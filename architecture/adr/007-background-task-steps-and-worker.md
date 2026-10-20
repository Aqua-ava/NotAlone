# ADR-007：后台任务步骤与 Worker 执行边界

> 状态：已采纳  
> 日期：2026-08-12
>
> 任务幂等、重试、并发、留存和联系人记忆目录的后续细化见 ADR-015。
> 记忆页面的聊天处理量与显式恢复展示见[当前流程](../current/core-flows.md#6-后台任务边界)：聊天处理比例取已提交批次的实际数量，不能由模板权重代替；重启本身不扫描旧队列，沿 ADR-041 由用户明确继续。

## 背景

导入长聊天记录、级联删除和重建索引都可能跨越多个处理阶段，并遇到文件损坏、模型暂时失败、Worker 重启或部分存储写入成功等情况。只有一条总体进度记录时，系统无法准确说明失败位置，也难以从安全位置恢复。

候选回复已有 LangGraph 图，但该图面向一次短时回复请求。把长任务、LangGraph checkpoint 和模型计划混为一套状态，会让 PostgreSQL 业务真相、运行恢复和用户进度互相冲突。

## 决策

1. PostgreSQL 使用 `background_task` 保存一次完整长任务，使用 `background_task_step` 保存需要独立恢复、重试或展示的固定步骤。
2. `jobs` 模块按任务类型创建确定性步骤模板。v1 不允许模型自由新增、删除、跳过或重排步骤。
3. Worker 是模块化单体代码库中的独立 Python 进程。它以原子更新和短租约领取步骤，调用对应处理器，并写回状态、错误和业务对象引用。
4. 步骤处理器必须幂等。Worker 崩溃、租约过期或调用重试时，重复执行不得生成重复消息、记忆、索引或删除副作用。
5. AI 只在语义理解步骤中通过 `ModelPort -> gateway` 被调用。AI 返回结构化候选结果，但无权领取任务、改变步骤状态或宣布任务成功。
6. 所有业务步骤完成后，父任务进入 `verifying`。确定性校验器验证联系人隔离、来源关联、数量/索引一致性和删除不可检索性；只有验证通过后才进入 `succeeded`。

## v1 任务模板

```text
import: parse -> normalize -> extract_memory -> index -> verify
delete: mark_deleted -> delete_derived -> delete_index -> clear_cache -> verify_not_retrievable
reindex: select_scope -> rebuild_index -> verify
```

步骤名称是业务协议，具体实现可以在不改变外部语义的前提下合并内部函数。单次候选回复由 LangGraph 编排；前台会话的一次轻量 OCR 增量通常同步处理，不创建步骤清单。

## 状态与所有权

```text
background_task: queued -> running -> verifying -> succeeded
                              |             |
                              +-> failed <--+
                              +-> cancelled

background_task_step: pending -> running -> succeeded
                                   |
                                   +-> retryable/failed
```

- `background_task_step` 至少记录父任务、步骤类型、顺序、状态、尝试次数、`worker_id`、`lease_expires_at`、错误分类以及输入/输出业务引用。
- 业务引用保存对象 ID 和来源范围，不默认复制聊天正文或模型完整输入。
- 任务阶段由已完成步骤确定，不能由模型自由填写。模板权重仅可用于明确标注的阶段进度，不能冒充聊天处理比例；记忆页面采用已提交批次的实际完成数与可靠目标总量，无法确认时显示未知。

## 不采用的方案

- **仅保存 `background_task.progress`**：实现简单，但无法可靠恢复或定位部分失败，不适合导入和级联删除。
- **复用 LangGraph checkpoint**：回复运行状态与业务任务状态生命周期不同，会破坏 PostgreSQL 作为任务权威库的边界。
- **让 Agent/TodoWrite 管理步骤**：模型计划适合推理提示，不是具有并发、租约、幂等和审计语义的业务事实。
- **立即引入 Airflow、Temporal 或独立队列**：当前负载和工作流复杂度尚无证据需要这些运维成本；达到可测量瓶颈后再通过现有 `jobs` 契约替换执行基础设施。

## 结果

- 用户可以看到真实当前步骤、失败位置和重试结果。
- Worker 重启后可以从未完成步骤恢复，并通过租约避免多个 Worker 同时执行同一步。
- 模型失败只影响对应语义步骤，不获得任务控制权。
- 系统增加一张步骤表、租约回收和幂等测试的实现成本，但换来导入与删除的可恢复性和可审计性。
