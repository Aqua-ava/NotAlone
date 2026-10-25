# TS 诊断问题预算工程切片

日期：2026-10-25。已冻结，可交根联合集成及独立复审；本切片未暂存、提交、操作桌面或调用真实模型，未创建真实诊断账本。

## 交付与接口

- 自有八个文件及 SHA-256：同目录 `files.json`；含独立预算模块、provider、接口说明及五个专用测试／fixture。
- 外部必要依赖：腾讯移植负责方修改的 `backend-ts/src/l2-scenario-model.ts:269`，SHA 同 manifest；本切片未修改或认领该文件。`host-model-accounting.ts`、PG schema、记忆算法未改。
- `diagnostic-problem-budget.ts:20` 绑定原 `NOTALONE_PROBLEM_BUDGET/ROUND`，Node 原生 SQLite 与 Python 共用既有 `budget/rounds`；无新增表或依赖。
- 普通／strict 在 `model-provider.ts:87`、`:144` 物理发送准备处各预留一次，原 PG 回调后复验；失败、unknown、取消及 PG 拒绝不退款。
- optional `before_dispatch_started` 默认显式 false，进入原回调前同步 true；L2 仅 `===false` 才安全 settle，true／缺字段不猜测已发送或已预约。
- 启用、原许可与错误边界见 `backend-ts/diagnostic-problem-budget.md`。两个变量必须进入实际 DSH 进程启动环境；仅改其他 shell 或运行时 `.env` 不生效。

## 验证证据

- 真实本机 HTTP + 合成 PG：跨 permit／进程／重启／目录，两个进程十二次竞争最多八次 HTTP，第九次零增量；E、strict-V、B、关系、合并、真实 L2/L3 port 与学习共账。
- 覆盖发送前截止、PG 授权等待跨截止、未结案、连续两轮无改善、PG 拒绝／取消／503 不退款、原 transport unknown 重启不重放、未启用兼容。
- L2 真实 port 原 RED 为 cap 前拒绝后 `ack_unknown`／orphan；与负责方接入回调标记后 GREEN。有效 PG reserve ACK 被本机 Unix 代理破坏的反向案例仍精确断言 `l2_scenario_model_ack_unknown`、HTTP0、无 settled、原 pending 回执及未知许可保留；未放松断言。早期代理闭包指错目标已在专用 fixture 修正。
- Python CLI status/start/finish、客户端 reserve 与 TS 双向并发、私有权限、固定文件身份及旧显式继续授权兼容均通过。
- 最终相关组 **32/32**，`npm run typecheck`、`git diff --check` 通过。命令均在 `backend-ts/` 使用项目 Node 环境：

```sh
perl -e 'alarm 120; exec @ARGV' -- node --test --test-concurrency=1 test/diagnostic-model-budget.test.mjs test/diagnostic-problem-budget.test.mjs test/model-provider.test.mjs test/extraction-model.test.mjs test/host-model-accounting.test.mjs test/l2-scenario-host.test.mjs test/l2-scenario-shared-host.test.mjs
npm run typecheck
```

## 数据与未闭合边界

预算模块不接收正文、凭据或联系人；唯一持久修改为计数加一。真实 HTTP／usage 仍由原 PG receipt 独立核对；预留数不是 HTTP 数或费用。
合成 PG、provider 和临时账本由 fixture 清理；原始验证日志留仓库外 0700／0600。无 App、打包或运行时构建产物。
真实问题此前调用总数 **unknown**；新统计起点、固定问题 ID／路径及八次／三十分钟由根在私有启动记录中锁定，本报告不将新计数冒充历史总数。
本模块不会识别故意改 env／问题名或手工清零的语义绕过，也不会为旧未知任务授予重放资格。工程通过不代表真实记忆质量改善、产品可启用或最终迁移验收通过；实际小批与独立复审由根继续。
