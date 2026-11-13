# Ticket 26 桌面退役交接
- 范围：仅桌面启动/诊断/受管PG/默认开发监督与对应合成测试；未操作App、微信、原库、模型、配置、预算或Git index。
- 默认配置固定runtime=dsh，无HOST标记也可运行；pythonExecutable无论存在/失效/非路径均忽略，不stat/exec，不改原文件。
- 新StartupPaths不含Python；主动保存只写项目/env/info/CLI/probe非秘密路径，旧Python字段剔除。
- 原env/info/userData/managed/postgres/state/runtime.env位置保持，116SQL未改；无业务或隐私边界改动。
- process只经既有launchDsh；diagnostics读/schema准备与managed PG监督均经Node；移除Python watcher及启动帮助。
- 复用须runtime=dsh、hostRuntime=typescript、无legacyPid、完整ownership为TS/unavailable；schemaUpdates可typescript-migration-command。
- 已认证旧DSH只保留停读目标，业务拒绝，正常认证退出可用；shutdown响应无需完整status责任字段。
- 最终manifest：paths仅project/postgres，minimumRuntimeComponents=1；PG四命令X位，TS/profile源码仅校验库存和摘要。
- DSH依据：锁定0.2.1-rc.2；读取backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js:12-27及backend-ts/profile/host.patch.yml，既有--profile notalone合同不改；无新增第三方API。
## 修改文件
- desktop/src/main/backend/config.ts
- desktop/src/main/backend/process.ts
- desktop/src/main/backend/host.ts
- desktop/src/main/backend/runtime-client.ts
- desktop/src/main/startup/diagnostics.ts
- desktop/src/main/startup/managed-runtime.ts
- desktop/src/main/startup/managed-manifest.ts
- desktop/src/shared/startup-bridge.ts
- desktop/src/renderer/StartupSettings.tsx
- desktop/managed-runtime-contract.mjs、desktop/managed-runtime-contract.d.mts
- desktop/scripts/dev.mjs
- desktop/tests/pure-ts-startup.test.mjs、pure-ts-managed-runtime.test.mjs
- desktop/tests/startup-schema-guard.test.mjs、startup-continuity.test.mjs
- desktop/tests/managed-shutdown.test.mjs、backend-startup-budget.test.mjs
- desktop/tests/development.test.mjs、packaging/managed-runtime.test.mjs、startup-diagnostics.spec.ts（仅历史对象构造类型兼容）
## 最小验证
- 以下node均为node（本机已核验Node24，绝对路径保留在端侧执行记录），从desktop运行。
- node --test tests/pure-ts-startup.test.mjs tests/startup-schema-guard.test.mjs：13/13。
- node --test tests/managed-shutdown.test.mjs tests/startup-continuity.test.mjs：当时18/18；随后新增旧壳认证停读单例通过。
- NOTALONE_TEST_PG_BIN=<现有PG16命令目录> node --experimental-strip-types --test tests/pure-ts-managed-runtime.test.mjs：1/1；只运行PG二进制，无Conda/Python调用；随机自有cluster收尾。
- node --test --test-name-pattern=自有后台异常退出 tests/backend-startup-budget.test.mjs：2/2；未重复迟到窗口/性能对照。
- node --test --test-name-pattern='DSH连接|已认证旧DSH|开发模式固定当前仓库源码' tests/managed-shutdown.test.mjs tests/development.test.mjs：3/3（含2项重复聚焦）；独立用例累计36。
- node --check desktop/scripts/dev.mjs（根目录）、node --check tests/packaging/managed-runtime.test.mjs及本分工git diff --check通过。
## 集成剩余
- root脚本落地后已跑node --test --test-name-pattern='独立运行时检查|打包检查逐项|构建和App载入' tests/packaging/managed-runtime.test.mjs：3/3；累计39独立最小用例通过，未运行制品构建。
- root统一一次TSC/必要集成、npm run dev实际验收及本地提交；C隔离旧Playwright Python链；不宣称本分工已做GUI或发行验收。
- managed PG测试现在用NOTALONE_TEST_PG_BIN显式选择PG16目录，避免默认硬编码Conda；本机已有PG路径仅借作合成数据库命令。
