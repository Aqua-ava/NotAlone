# 合成宿主／夹具最终回归

状态：授权范围内两项夹具修复已冻结；宿主生产身份缺陷待主协调处理，Ticket25 未据此标完成。

## 已交付

- `model-organization-ack-host.mjs` 直接加载正式源码依赖图；保留独立进程、PG、许可 socket 与 journal，取消手抄源码复制清单。缺依赖最小红例已转绿，12/12 原模块通过。
- `sync-incremental-reconnect-fixture.mjs` 的排空断言只统计 `client backend`，保留实际值必须为零、失败缓存、紧急回收及多错误聚合。
- 新增真实 PG autovacuum 合成回归：后台 worker 不误计；一条与两条真实残留客户端仍分别失败为 1、2；关闭客户端后以 0 连接正常 DROP，停止且删除本轮专属集群。
- 传递依赖已核对：53 份本地源码的静态导入超集（含 type），缺失为 0；包导入为锁定项目的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`pg`、`yaml`。正式运行时自动解析，不再复制清单。

## 证据与解释边界

- 原全量失败日志只读且 SHA 未变；其 owned 摘要、最小红绿日志、最终日志及 raw/public SHA 见 `evidence-index.json`。
- 原 reconnect 最小用例单跑与受控并发 12/12 均绿。隔离 PG 集群稳定构造出同样的 2（autovacuum worker + 故意保留的 client），证明原计数口径可误报；不声称已观测到历史全量样本当时的 backend_type。
- 原 host 最小用例单跑与受控并发 12/12 均绿。另一个真实最小红例稳定证明 macOS `Z <defunct>` 被 `process-identity.ts:14` 错判 `unknown`，会使 `launch.ts:68` 立即拒绝清理；未把 20 秒超时加长，也未改原宿主断言。
- 生产文件未改。精确建议、红例和仅供主协调应用的补丁分别见 `production-change-request.md`、`zombie-identity-probe.mjs`、`proposed-process-identity.patch`。
- PostgreSQL 16.15 实测；已核对 [PostgreSQL 16 pg_stat_activity 官方文档](https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW) 区分 `client backend` 与 `autovacuum worker`。未改 DSH API；使用项目锁定的官方 profile，`@deepseek-ai/dsh` 为 0.2.1-rc.2。

## 实际验证

环境：Node 24.19.0（桌面 bundled runtime），Conda NotAlone Python；以 `env -i` 仅传 HOME、USER 与运行时 PATH，未读取项目 .env。

- 红：`cd backend-ts && node --test --test-name-pattern='^L2 contact HTTP200 lost' test/model-organization-ack.test.mjs`，ERR_MODULE_NOT_FOUND；修复后同例通过，模块 12/12。
- 红：`cd backend-ts && node --test --test-name-pattern='^排空统计排除' test/sync-incremental-reconnect.test.mjs`，真实 vacuum 被误计为 1；修复后通过，残留 1／2 精确拒绝。
- 最终：`cd backend-ts && node --test --test-concurrency=3 test/model-organization-ack.test.mjs test/sync-incremental-reconnect.test.mjs test/host-launch.test.mjs`：26/26，0 fail，28805.694416ms。
- 范围外生产红例：`node .scratch/dsh-ts-migration/final-host-fixture-regression/zombie-identity-probe.mjs`：`unknown !== gone`；本轮合成父子进程均正常回收。
- Python 新夹具 AST 语法检查、授权 tracked 文件 `git diff --check` 通过。

## 数据、资源和剩余工作

仅合成独立库、临时 socket／目录和 loopback HTTP。原 393216 默认、来源、授权、取消、unknown、质量边界无改动；没有外部模型、真实资料、实际 App／微信、打包、push、PR、index 或 commit 操作。
正常用例经正常 DROP；故意泄漏用例保留原断言与重复 close 的同一失败，再只回收本测试库。24 个空压力测试目录已删除；原始新日志保留在端侧 0700 目录／0600 文件，共 57719 字节，公开副本已移除本机路径。详见 `cleanups.json`。
三个既有人类 desktop 修改、共享 `host-storage-fixture.mjs`、原模型测试和原 host 测试均保持初始哈希；不触碰 exploration-*。详见 `ownership-boundary-check.json`。
主协调按 `manifest.json` 集成四个测试文件并创建本地提交；另行处理生产 zombie 红例后重跑宿主模块及其相关生命周期测试。未跑 backend 全量，不把本次通过当成完整迁移或真实渠道验收。
