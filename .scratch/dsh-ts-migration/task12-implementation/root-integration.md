# 票 12 根集成说明

状态：TS 查询、删除和独立 HTTP 适配器候选已完成；共享宿主未改，生产入口仍由根集成决定。

## 交付边界

- `SourceProcessingTraceStore` 只读既有 `memory_extraction_trace*`、`source_processing_*`、`message*`、`source_document` 和最小台账表，不创建第二份正文副本。
- `SourceProcessingTraceApi` 是普通 HTTP 适配器，不持有 DSH Agent、Provider、Tool 或模型许可；无模型配置时查询与删除仍可工作。
- `deleteMemoryTrace()` 只清追踪正文和依赖，保留权威消息／记忆及无正文 link／call。
- `deleteSourceBatch()` 删除来源处理正文并写 capture tombstone，再按完整窗口和来源依赖清受影响追踪。整个来源／联系人的跨域删除仍由票 17 和根删除事务协调。
- 正在处理的追踪可读且明确标为 `in_progress`／`partial`；来源删除中、来源已失效或跨联系人访问返回 404，不回正文。

## 宿主接线

1. 在 `backend-ts/src/host-plugin.ts` 导入 `SourceProcessingTraceStore` 与 `SourceProcessingTraceApi`。
2. 以已配置的 `storage.runtimeOwnerId` 和现有 `progressPool` 创建一次 API；不要创建新连接池，也不要启动 Worker。
3. 在通用认证之后、legacy proxy 之前接入 `/api/contacts/:contactId/memory-traces` 与 `/api/contacts/:contactId/source-processing-traces`。GET／DELETE 均沿用现有 `respond()` 的 `Cache-Control: no-store`。
4. 用同一条路由门禁选择 TS 或 Python 责任，不做请求级双读写回退。根切换时保持 trace 查询无需模型运行；宿主退出继续由原 `progressPool.end()` 排在模型和 Python 排空之后。
5. 本票不提交 `host-plugin.ts` 改动；精确 patch 见 `host-integration.patch`，需在主树集成时重新核对行号与当前路由顺序。

## 协议与兼容

- 保留现有桌面控制器所需字段：列表 `batches`／`next_before`；详情 `trace_id`／`batch_id`、`status`、`events` 或 `records`、`calls`、`links`、`write_receipts`、`candidates`。
- 新增 `sources`、`source_documents`、`messages`、`source_processing_batches`、`tasks`、`versions`、`failure`、`completeness`、`process_record`、`model_ledger`；旧 UI 可先忽略新增字段。
- 任务入口为 `GET /api/contacts/:contactId/memory-traces/tasks/:taskId`，也可走 `records/task/:taskId`。任务只从实际 `window` 事件中的 `task_runtime.task_id` 导航，不根据进度估算。
- 脱敏诊断入口为 `GET /api/contacts/:contactId/memory-traces/:traceId/diagnostics`，只返回计数与分类。

## 集成前依赖

- 原 Python TaskHost 仍是唯一完整追踪写入和 `batch_end`／水位提交方；本模块不替代写入、ACK、租约或水位。
- 根切换到 TS B 段时，必须保留票 11 的单项事务、部分提交结果协调和 `trace.complete`／processing receipt／watermark 原子尾事务。
- 真实 DSH 最终 wire 请求／返回捕获和实际 ModelHost 调用仍按票 05／25 验收；本模块只读取这些路径已经保存的事实。
- 桌面任务导航需要后续受控 UI／控制器接线；本票没有修改现有 React 管理页，也没有运行实际 App。

## 最小集成验证

1. 用随机 `_test` PostgreSQL 通过真实 HTTP 适配器建联，验证列表、详情、记忆／任务反查、诊断和删除。
2. 合成来源删除中时确认 404 且无事件正文；完成后确认 status `deleted`、events 为空、最小台账仍在。
3. 在 `window` 事件存在但 dependency／message link 缺失的旧合成数据上删除来源，确认仍清追踪。
4. 运行 `npm run dev` 后由根独占验证实际 App 可见行为；本票不启动 App／微信，不推送、不打包。
