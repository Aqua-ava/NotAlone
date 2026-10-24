# 票 16：TS `index|verify` 后续切片

## 现状（2026-10-25）
- 主树已合入票 16 的 TS 导入与唯一 Worker：`21564070`；主线证据为 `15b134a4`。
- 当前 TS Worker 只领取 `parse|normalize|extract_memory`；票 13 将再加入
  `organize_memory`。`index|verify` 仍只有 Python 执行者，启用
  `NOTALONE_TASK_WORKER_RUNTIME=typescript` 会让真实任务停在提取之后。
- `ran` 原任务 `4db4510b-a7e8-450b-b8b8-cc0b3b71751e` 仍含待执行
  `extract_memory|index|verify`；根只读核对未产生重复任务或 trace。

## 原合同
- 步骤序列见 `architecture/adr/007-background-task-steps-and-worker.md:24`。
- Python 工作分支见 `backend/src/notalone/tasks/worker.py:650` 的 `index` 与
  `backend/src/notalone/tasks/worker.py:681` 的 `verify`。
- 确定性目录构建/持久化见
  `backend/src/notalone/persistence/contact_memory_index.py:118`、`:307`、`:406`；
  参考测试见 `backend/tests/integration/persistence/test_contact_memory_index.py:115`。
- `contact_memory_index` 最多 20 个主题；只索引当前有效、来源仍有效的
  active `confirmed_memory`，按 `owner_id + contact_id` 隔离，不保存正文，不调用模型。

## 实施边界

- 在票 13 提交后的同一唯一 Worker 中支持 `index|verify`；步骤完成、租约复验、
  attempt 和父任务状态继续由原有任务事务完成。
- 在持锁事务内读取 `contact_memory_state.memory_revision`，按 Python 同一排序和
  时效/来源规则构造 topics；同一 revision 重放保持幂等。
- `index` 成功后必须读回验证 status、revision、主题上限、引用与源记忆；失败保留旧目录。
- `verify` 无效时返回原稳定错误（`index_missing|index_not_active|index_stale|
  index_reference_invalid`），不把任务标成功；数据库故障保持 retryable。
- 不接管票 17 的删除任务族，不扩大成任务管理票 22；不降低取消、来源撤销、
  联系人隔离或单写门禁。

## 验证与交接

- 合成 `*_test` PG 覆盖：空目录、过期记忆、20 主题上限、增量/重建、删除后
  stale、来源失效、本人 `contact_id=NULL`、跨 owner/contact 隔离、晚替身竞争。
- 先单测，再跑 `extraction-task-store|runner|worker-control`、导入/任务宿主和 tsc；
  不用真实资料、App、微信或外部消息做会话内验收。
- 票 13 提交合并后，由根用 `create_thread` 创建全新用户可见会话，从该提交建立
  worktree；不得用 sub-agent 代替。完成后根独占 `ran` 的实际 App 验收。
