# 同步减负 06 收尾交接（2026-11-08，channel 簇攻坚）

下一个会话的唯一目标：收敛 `backend-ts/test/sqlite-wechat-history-channel.test.mjs`（14 失败 + 1 挂死），然后走完 06 终验与提交。本文件是总交接；既有材料优先看引用而不是全文重读。

## 背景与现状（三句话）
- 任务 06 按 [ADR-177](/Users/local-user/Documents/learn/NotAlone-sync-remaining/architecture/adr/177-retire-source-recertification-and-cleanup.md) 退役持久守卫/重新认证/副本清理；工作树 `NotAlone-sync-remaining`、分支 `codex/sync-simplification-remaining`（HEAD 5cdfb57e3），**178 项改动全部未提交——06 未达验收前不要提交半截**。
- 01-05 阶段已提交并 resolved；06 的行数删减/编码完成但测试未全绿。
- Codex 源会话 `~/.codex/sessions/2026/11/07/rollout-…-01a1b591….jsonl`（8.1M）仍在，可找历史证据；诊断与基线在 `~/.local/state/notalone/diagnostics/sync-simplification-remaining-20261107/`。

## 本轮已完成的修复（均复跑绿，别回退）
1. `src/storage/sqlite/deletion/holders.ts`：`releasedOnFailure`——close 回调声明读者排空后，close 失败不再把已结束读者当活引用。回归在 `test/sqlite-history-guard.test.mjs` 末尾 2 用例（guard 40/40）。
2. `src/history/sqlite/service.ts` `prepareSource`+`waitForDrainedReader`：done 已结束但 close 失败 → 按停读入口重试真实排空。红转绿判据 `~/.local/state/.../six-holder-failure-diagnostic.mjs` 2/2；source-preparation 7/7。
3. `src/history/sqlite/deletion.ts:53`：collect 对 `history_source_equivalence` 加 sqlite_schema 存在性守卫（46 库不再 storage_invalid）；restart 套件 2/2。
4. `service.ts` syncIncremental ~421-431：无 `resumeTarget` 的旧读取器不再提前 return，本租约内按 ADR-177 扫完终页再续增量。⚠ 修改时保留 handoff 的 try/catch 与 `}` 闭合（曾误删后复原，勿再破坏）。
5. `src/history/sqlite/actions.ts` `resumeCheckpoint` ~161-181：增量行 `invalidated/history_runtime_revalidated` 仍为合法恢复点 + `ORDER BY (kind='incremental') DESC,creation_no DESC`——重建守卫接续最新已接受增量。durable-resume 3/3；注意 SQL 里注释必须用 `--` 不是 `//`（曾犯）。

## 未完成 1：channel 簇（唯一阻塞）
单跑：`cd backend-ts && perl -e 'alarm 150; exec @ARGV' -- node --test --test-timeout=30000 test/sqlite-wechat-history-channel.test.mjs`
失败例（均不在两基线清单，属 06 改写共享通道/park/图片隔离族的语义后果；测试文件本身未被 06 改动）：
- 正式受控渠道驱动联系人历史服务入库…（test:122，断言 `channels 2!==1` @131——第一例根因线索：共享通道计账本）
- 正式历史终页游标交接到同scope增量尾部…（test:135）
- 增量消失记录的未知墓碑隔离…（151）
- 正式渠道拒绝带额外字段的边界结果及超限tail…
- 合成原生进程意外退出保留本机事实… / 共享历史进程串行同步两位联系人… / 关闭已park联系人不影响当前联系人…
- **挂死**：共享通道park失败确认原进程停止后，宿主重试只续清原资源（>30s，0% CPU 空等）
- 共享切回与记忆来源重验保留持久增量恢复… / 历史读完后连接失守卫保留已保存覆盖…
- 对照组（旧守卫语义的负对照，须按 ADR-177 攤断言而非全删）：对照：旧制品单图失败关闭所有守卫… / 对照 10位联系人… / 对照 100位联系人… / 来源类图片错误终止共享读取…
基线对照文件：`final-current-failures.json`(45)、`final-baseline-failures.json`(46)。终验要求：相对 f687 基线新增失败 0。

## 未完成 2：channel 收敛后的终验队列
1. 全量：`cd backend-ts && perl -e 'alarm 900; exec @ARGV' -- npm test` 全程跑完再对照基线（上次两次自跑都卡死在 channel 套件）。
2. 47 库副本两轮回放：驱动 `~/.local/state/.../six-copy-sync.mjs`（replica=replay-06-schema47，真库 stat 双读防护已内置），预期 caughtUp 16/16×2 轮、references/messages/bindings/needs 不变。
3. 隔离开发 App：合成目录 `~/.local/state/.../desktop-06-synthetic/`（user-data+synthetic.env+plan.json+check.mjs），`cd desktop && pnpm run dev:status` 后 `pnpm run dev --user-data-dir …`；禁打包；Computer Use 界面核验；不发微信消息。
4. closeout 文档：`docs/verification/sync-simplification-06-retirement-20261107.md`（现有正文大体有效，之前写就；追加收尾修复段并收敛 `<!-- METRICS -->`、`<!-- BACKEND_FULL -->` 占位）。
5. 按主题分块提交（Conventional 中文无署名，只提交本任务，不 push）。

## 指标与放行项（收尾时如实记录）
- history/sqlite 现 36 文件/4604 行；基线 62/6560；issue 目标 ≤4592（即 30%），当前 29.82%，收尾修复净增 ~17 行所致，未压行。是否放宽由收尾报告说明、用户定夺。backendSrcTs 310/37449；tsc 通过。
- 放行项：startup-host『manual正式profile…』= 双基线命中允许失败（该文件唯一红）。

## 教训与协作约束
- 本环境 Agent 子任务多次空回传（4 次，烧 token 无产出）：**channel 簇直接自己做**，勿再委派。
- 临时 worker 诊断需原文还原（本次已净）。
- 真实库只读；禁打包；核验先 `dev:status` 复用；等待类操作用有界等待；与桌面无关。

## Suggested skills
- `tdd`（channel 簇红→绿小步推进）、`diagnosing-bugs`（挂死定位）、`implement`（终验队列第 2-5 步）。
- 入口文档：`docs/agents/workflow.md`、`docs/agents/engineering.md`、`docs/agents/issue-tracker.md`、`architecture/current/wechat-sync.md`（.scratch 亦见 session-handoff-20261108-root.md 与 spec.md/remaining-handoff.md）。
