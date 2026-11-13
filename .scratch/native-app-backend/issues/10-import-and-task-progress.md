# 10 — 导入与任务进度

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 用户在主窗口完成历史导入：选择 JSONL 文件、预览校验结果、选择或新建联系人后正式导入；导入完成后可一键触发记忆提取任务，任务步骤在后端进程内执行，进度与结果统计经事件通道实时推送；失败显示错误分类并可重试，中断后重新触发从未完成步骤继续。

**Blocked by:** 02（事件总线与 SSE 契约）、05（主窗口骨架）

- [x] 导入预览与正式导入共用既有命令的同一逻辑：单联系人归属校验、混联系人拒绝、同一事务写入与幂等。
- [x] 任务触发始终由用户动作发起；不引入定时器或无人值守调度。
- [x] 任务步骤进度（当前步骤、计数、尝试与重试）经事件实时推送；终态结果统计可在界面查看。
- [x] 模型或网络暂时失败的重试与租约续期语义不变；中断后重新触发从未完成步骤继续。
- [x] 既有 `task-worker` 命令保留为兜底恢复工具，与后端进程内执行共用同一任务执行路径。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-007、ADR-014、ADR-015、ADR-018。
- 后端进程内执行与命令行 Worker 的全局串行语义需要一致：同一任务不被两个执行者并发处理。

## Answer

- 后端新增端点：`POST /api/imports/preview`（完整校验 + 结构化预览：文件名校验、记录数、类型分布、owner/联系人渠道身份，失败 422 `preview_failed` 稳定码）；`POST /api/imports/commit`（既有联系人 `contact_id` 或新建 `new_contact_name` 二选一，复用 `import_file` 同一逻辑，同一事务 + 幂等）；`POST /api/tasks/run`（触发当前联系人任务，已有执行线程返回 busy）；`GET /api/tasks/status`（进度快照）。
- 新增 `application/import_service.py`：`ImportService`（预览/提交复用 build_preview/import_file）与 `TaskHost`（进程内线程执行,复用 `run_worker` 同一执行路径与全局 advisory 锁,保证与 CLI task-worker 串行;每步经 `progress_callback` 实时发布 `TASK_PROGRESS` 事件到事件总线,失败关闭记录稳定 error_code）。
- `run_worker` 增加可选 `progress_callback`（每步结果产生后调用），CLI 调用方不传保持原行为；CLI `task-worker` 保留为兜底恢复工具。
- Swift 右栏新增「导入」页：文件路径选择（NSOpenPanel）、预览校验摘要、选择既有联系人/新建联系人提交、任务触发与进度展示（步骤/处理/尝试/重试、轮询兜底进度）。
- 验证：Python 全量 614 项通过（新增 ImportService/TaskHost 单测 8 项、API 契约 12 项）；`swift build` 与探针 `swift test` 21 项通过；真实 HTTP 冒烟：预览 fixture 200、不存在文件 422 稳定码、任务触发 started、无凭据环境任务失败关闭（worker 构建抛错 → internal_error）。
- 双轴 code-review（Standards + Spec）修复：`commit` 直接复用既有 `import_file`（消除薄壳违规的重复逻辑）；进度参数打包为 `TaskProgressUpdate` 值对象（消除位置参数簇）；服务装配缺失返回 503 `import_task_unavailable`（不再伪装成 400）；Swift SSE 客户端消费 `TASK_PROGRESS` 事件实时更新进度（轮询兜底保留）；终态与每步事件透传错误分类 `error_code`（重试计数经回调实时携带）；SSE 进度按当前视图联系人过滤（范围隔离）；`commit` 仅业务拒绝映射 409（归属冲突/联系人缺失/校验失败），基础设施异常不再伪装成冲突。
- 数据影响：测试使用合成 UUID/`_test` 库与既有 fixture；无迁移改动。
- 剩余风险：真实凭据环境下任务全链路（提取 → 采纳 → 索引 → 校验）依赖 DeepSeek key，冒烟坏路径已验证；导入大数据量文件的界面反馈依赖后端单次处理（与既有命令语义一致）。
