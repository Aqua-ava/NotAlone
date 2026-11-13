# 05 管理页读取改为按联系人批量核验来源

Triage: ready-for-agent
State: resolved
Blocked by: 无（与日志任务独立，不应等待）

## 现象与证据
- 王威记忆页读取约 4.8 秒（本机库副本空载，三次 4.74 至 4.87 秒；16 条记忆、1 条候选、约 38 KB）。
- 逐语句计时：来源资格核验 SQL 被调用 3383 次、合计约 4.6 秒；其余语句合计不足 0.3 秒。
- 路径：`backend-ts/src/memory/sqlite/management/read.ts` 的 `summary` → `checkedVersion` → `versionView` → 单条 `assertSourceEligibility`；`backend-ts/src/history/sqlite/source.ts` 已有批量的 `eligibleSourceReferences`，未被使用。

## 内容
- 把版本来源核验改为按联系人批量，保持"来源失效项不进入页面、核验语义不放宽"。
- 不改变 `memory_source_stale` 等错误码语义；管理页读取 10 秒超时不放宽。

## 完成条件
- 同一库副本上读取耗时对比修改前后（附数据）；相关测试通过；核验结果与修改前逐项一致（含来源失效项被撤下）。

## Comments


## Answer

已完成。用户确认由另一活动会话负责修复与提交，本会话独立核验；修复提交为 `2068bb54b`（`fix(memory): 批量核验管理页来源并区分读取超时`）。修复按本页实际来源及 `owner_id + contact_id` 建立资格集合，候选与版本共享；严格读取资格与已保存资料资格分别核验，未跨请求保存缓存，原 `memory_source_stale` 及管理读取 10 秒时限保留。

独立基准使用同一个真实 SQLite 库副本，基线源码经 `git archive baae193625d43d7315f04c989d3685922f1f4fec backend-ts/src` 固定，修改后来源核验相关七个源码文件指纹为 `5f03f062efebd4d6d666f7f1a2f49bc791da59a534dfa286fb0ed16a3974da2c`，测量期间保持稳定。每个场景重复三次，使用正式 `managementRead` 及 SQLite `statementCache`；修订变化和证明失效只在副本事务内模拟并回滚。

| 场景 | 修改前各次耗时（ms） | 修改后各次耗时（ms） | 平均前→后（ms） | 资格 SQL 前→后 | 核验结果 |
| --- | --- | --- | --- | --- | --- |
| 正常资料 | 5457.33、8759.98、7029.76 | 475.09、222.43、206.64 | 7082.36 → 301.39 | 3383 → 1 | 1 候选、16 记忆，16 条可见 |
| 一条来源修订变化 | 3799.01、3804.47、3659.34 | 212.33、231.89、263.39 | 3754.28 → 235.87 | 1966 → 2 | 1 候选、16 记忆，9 条可见、7 条撤下正文 |
| 来源证明失效 | 109.04、91.48、95.09 | 22.24、20.88、21.62 | 98.54 → 21.58 | 49 → 2 | 0 候选、16 记忆，16 条全部撤下正文 |

正常读取中位数为 7029.76 → 222.43 ms；均值约快 23.50 倍，总 SQL 8517 → 5169。三个场景逐条候选／记忆 SHA-256 及完整返回值 SHA-256 均一致；完整返回值摘要分别为 `fdd68fc2f3304d5dd62532f967fe632cf760f3322bf554e76896a67e157505a5`、`d4d00cb75bceebe44e9dd1156bf48aeb4beb37b81c7746532e1a04410c265f82`、`e36be6cf8307c2458fd37c11f31a0358f15b8635522e86b6b75cd05f0c873627`。这同时验证来源失效项继续被撤下，未因优化放宽读取。

实际运行命令与结论：

- `node backend-ts/scripts/benchmark-management-read.mjs before <真实库绝对路径> <联系人编号前8位>`：创建目录 0700、文件 0600 的独立真实库副本；仅返回计数、耗时和摘要，不输出正文。
- `NOTALONE_MANAGEMENT_READ_MODULE=<冻结源码绝对路径>/backend-ts/src/memory/sqlite/management/read.ts node backend-ts/scripts/benchmark-management-read.mjs baseline <副本目录>`：使用固定基线源码在同一副本重测，结果见上表。
- `node backend-ts/scripts/benchmark-management-read.mjs after <副本目录>`：退出 0，三个场景 `equal: true`、`itemsEqual: true`。
- `node --test --test-name-pattern='管理页10' backend-ts/test/sqlite-memory-management-source-batch.test.mjs`：退出 0，4/4 通过，10／100／400 条来源均只执行一次同联系人资格 SQL。
- `node --test backend-ts/test/sqlite-memory-management-source-batch.test.mjs`：退出 0，7/7 通过；覆盖部分失效、本地待复验、本人显示范围、跨请求重新核验、当前页边界及正式采纳版本／候选。主 Agent 已亲读 diff 并独立重跑 7/7 通过。
- `node --check backend-ts/scripts/benchmark-management-read.mjs`：退出 0。
- `node backend-ts/scripts/benchmark-management-read.mjs cleanup <副本目录>`：退出 0，`cleaned: true`；真实库副本、冻结源码与含临时路径的中间报告均已删除，未更改业务原库。

验证范围与风险：该对照包含真实 SQLite 查询，不含 HTTP、IPC、实际 App 渲染或模型调用；同期存在其他开发活动，绝对耗时受 CPU 竞争及冷暖缓存影响，因此同时报告原始样本、逐项一致性及查询次数。主 Agent 统一执行桌面验收，此处不以后台基准代替界面结论。修复源码及测试全部属于 `2068bb54b`；本 Agent 仅新增可复用基准脚本，本地提交为 `33b66ca7c`，未提交或还原用户原有三处未提交改动，也未接触临时诊断接入。

提交后 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 退出 0：检查 3483 个历史提交、1989 个当前文件，`issues: 0`。

### 最终扩大回归发现的夹具适配遗漏（处理中）

主 Agent 最终 `pnpm --dir backend-ts test`（600秒上限）为2287通过、12失败、2取消；图片格式相关项另归图片修复会话，逐项独立归因中。另 `sqlite-memory-verified-results.test.mjs` 的「完成后撤销一位贡献者授权」最小用例触发 storage_failed。当前 `verified-output-registry.mjs` 仍将 verifiedExtractionOutput 直接注册为 StorageAction.execute；05 在 outputs.ts 给该函数新增 sourceEligibility 第三参数，而 Worker.execute 的第三实参是 StorageLease，存在签名适配遗漏。按用户明确文件所有权，已向原超时/批量修复会话协调最小修复和提交，本会话不修改其对应测试或生产文件。等待固定旧版本对照及修复回归后恢复 resolved。

### 夹具遗漏修复与最终结案

独立固定源码对照：05前 `baae193625` 的同一贡献者撤权最小用例 PASS；`2068bb54b`、`4e97f2197` 及最终日志树均因第三参数错位 FAIL。原修复会话按用户文件归属提交 `9304b8cec`，只将 fixture.execute 包装为二参数调用，保留生产默认资格函数和 Worker 租约围栏；未改生产逻辑或用户WIP。

主 Agent 已亲读该提交单行 diff，并执行 `cd backend-ts && node --test test/sqlite-memory-verified-results.test.mjs test/sqlite-memory-management-source-batch.test.mjs test/sqlite-source-reference-batch.test.mjs`：16/16，退出0，4.56秒。`node scripts/check_public_history.mjs --ref HEAD --working-tree`：退出0，issues=0。无需重跑仍有效的同库性能对照（生产实现未变）；均值7082.36→301.39ms、来源资格SQL3383→1及三场景完整/逐项一致证据保持有效。State 恢复 resolved。后台全量其余图片失败另属图片变更，并非本批量核验遗漏；最终总体验证边界见04 Answer。
