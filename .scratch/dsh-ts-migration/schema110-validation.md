# 110 模型物理调用收据迁移验证

2026-10-24。主协调把冻结草案应用到当前工作树，独立复跑最小、相关模块和官方宿主验证。本记录只证明正式 schema 与启动门禁，不代表 05、Python 逐 HTTP 接线或生产切换完成。

- 新增 `110_model_call_receipt.sql`，不修改已执行的 001—109 SQL；文件 SHA256 为 `50a26e310a7ef8c38f2f4ee1615d1007748b2e53d481198f736eb856e22e54ed`。
- `HostStorage` 要求连续完整的 110 项账本、正确 checksum、24 个收据列及其类型/可空性、24 项有效约束与索引。未知版本、缺失列、NOT VALID、级联被改写等情况失败关闭。
- 真实合成 PG 从有数据的 109 升到 110；原有 UUID、来源、消息、记忆版本、助手数据及旧台账保持。旧未知用量不补零；合法 `owner_memory` 空联系人与删除级联独立验证。
- 版本门禁相关 fixture 显式固定 110；已有其他未提交 fixture 改动不属于本次提交。

验证顺序（固定 Node 24，目录 `backend-ts`）：

1. `node --test --test-concurrency=1 test/model-call-receipt-migration.test.mjs`：25/25。
2. `node --test --test-concurrency=1 test/host-storage.test.mjs test/auto-read-suppression-migration.test.mjs`：15/15。
3. `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck src/host-storage.ts`：退出 0。
4. `node --test --test-concurrency=1 test/host-http.test.mjs`：官方 profile/真实 PG 8/8。

全部测试无 skip，前后源文件 SHA 一致。日志保存在本机 `/tmp/notalone-schema110-root-current.log` 与 `/tmp/notalone-schema110-official-host.log`，不作为可移植交付依赖。独立 Spec 审查无 finding，主协调完成 Standards 复核。

只使用本机合成数据库与临时配置，没有私人资料、真实模型、微信读取或外部发送；未运行打包版。约束目录匹配实际在 PostgreSQL 16 验证，未声称已覆盖其他大版本的目录表达形式。共享后台仲裁、旧任务身份/预算、未知恢复、App 及质量性能对照仍需后续完成。
