# 票 16 宿主集成交接

- 分支：`codex/task16-contact-history-import`
- 基点：`65464802f8160082840a050e90ecd16809d3b8f9`
- 业务模块：`backend-ts/src/history-import-{format,service,api}.ts`
- 接入补丁：`16-history-import-host-integration.patch`（本分支未直接修改共享 `host-plugin.ts`）

## 根需完成

1. 在 `host-plugin.ts` 应用补丁，并在 `runtime/status` 中确认 `imports=typescript`。
2. 根装配唯一 `ExtractionWorker` 后，把 `wake(scope,taskId)` 注入 `HistoryImportApi`；当前补丁未注入时返回 `processing_deferred=true` 和 `worker_unavailable`，任务保持 queued，不执行模型。
3. 将桌面仍读取的 `/api/tasks/status|run|retry` 接到同一 TS 任务身份；`/api/imports` 不得再代理 Python。
4. 桌面控制器与桥接已收窄为既有联系人，拒绝 `new`/`new_contact_name`；根需用真实既有联系人做开发 App 验收。

## 验证边界

- 仅使用隔离合成 `*_test` PostgreSQL、合成 JSONL 与临时目录。
- backend 相关 51/51、desktop 相关 10/10 及两侧类型检查通过；宿主补丁 `git apply --check` 通过。
- 未运行 App/微信，未使用真实资料或模型，未打包，未 push/PR。
- 来源删除后的领取拦截复用既有 `ExtractionTaskStore.sourceAllowed`；跨域完整删除仍由票 17/根集成验收。
