# 06 异步准备取消回收

Triage: ready-for-agent
State: resolved

## 目标

取消/首个 202 体校验失败时尽量回收服务端准备任务，避免占满 120s 预算与并发槽。

## 证据

- `desktop/src/main/backend/json-client.ts:62-70,86-94`：taskId 校验通过后才赋值；abort 或 202 体非法时不发 DELETE。
- 服务端 `backend/src/notalone/server/assistant_preparation_jobs.py:41` 预算 120s；`PREPARATION_MAX_RUNNING=4`。
- 复核：`verify-desktop.md` B1/B3。

## 范围

- 从 202 原始响应尽力提取合法 `preparation_id`（即使其它字段校验失败）并登记；abort/异常路径 finally 保证 DELETE。
- 后端回执形状校验改为显式白名单（允许未来附加非敏感字段），保留正文泄漏拒绝。
- 服务端若已有取消接口则复用；不加新发送能力。
- 测试：扩展 `desktop/tests/async-reply-preparation.test.mjs` 覆盖「202 前取消」「202 体多字段」「非法体但有 preparation_id」路径。

## 验收

- `cd desktop && npm run typecheck` + `node --test tests/async-reply-preparation.test.mjs`；报告后端测试是否需同步（若改后端，跑相关 server 单测）。

## Comments

## Comments

- 实现：`performPreparation` 的 202 回执校验改为显式白名单（`preparation_id` UUID、`state==='preparing'` 必填，`retry_after` 可选正整数；未知非敏感扩展字段按白名单原则忽略，正文类键仍拒绝）。先登记合法 `preparation_id` 再做其余校验，`finally` 在取消/超时/回执异常（未完成）时一律对已登记任务发 DELETE，成功完成不发。
- 测试：`node --test tests/async-reply-preparation.test.mjs` 8/8（新增「202 回执附加非敏感字段」「非法体但有 preparation_id 仍 DELETE」「202 前取消不伪造删除」）。相关 5 个文件 `assistant-generation-preparation`/`contact-restore-coalescing`/`manual-confirm-session-recovery`/`assistant-candidate-version-ports`/`async-reply-preparation` 共 123/123 通过；`npm run typecheck` 通过。
- 后端：复用已有 `DELETE .../prepare/status/{preparation_id}` 取消接口，未改后端，故无后端测试需同步。
- 数据影响：仅主进程传输层；DELETE 只表达取消意图，业务终态仍由原任务权威回执结算；不新增发送能力。
- 未做真实 App 验收。剩余风险：首个 202 到达前取消时客户端尚无合法标识，只能放弃等待、无法回收服务端任务（测试固化该边界）；`retry_after` 只做形状校验，暂未消费为轮询间隔。
