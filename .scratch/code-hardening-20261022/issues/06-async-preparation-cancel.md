# 06 异步准备取消回收

Triage: ready-for-agent
State: open

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
