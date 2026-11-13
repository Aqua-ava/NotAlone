# 真实库：恢复现有 15 位围栏联系人

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 02

在 02 合并并让运行中的开发应用使用后，用新路径恢复现有 15 位围栏联系人。用户已授权由 Agent 在开发 App 里（Computer Use）直接操作；先恢复 1 位试，核对后再做其余。02、04 已合并，库已升到 46（备份：`backups/sqlite/before-migration-46-20261107.sqlite`）。

## 要做

1. 确认 02 已合并、dev 应用已重启使用新代码；备份真实库到 `backups/sqlite/`（`sqlite3 <库> ".backup ..."`，校验 `integrity_check`）。
2. 记录前置数字：围栏数、每位联系人绑定数与消息数、`logs/history-continuity.jsonl` 现状。
3. 在应用里逐位触发恢复（先 1 位试，再其余）；每位恢复后核对。

## 验收

- 15 位围栏全部解除或明确转为需确认；绑定数、消息数不增加；耗时与日志记录在案。
- 回复生成对这些联系人不再因围栏被拒。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments

## Answer

真实范围16位已恢复，16 needs_confirmation→0、16 ok；消息122163→122223，绑定50不变（每位有效1），九类引用和模型调用367不变，诊断仍原1条、无新围栏，无副本删除请求/操作。实际开发App同步总览16/16、无关注问题；最终版本两轮16位增量时间全部前进且ready，无错误。

先用App上限1尝试2593a5cb，旧读取器能力不足126ms失败且数字不变；切换读取器时未暂停同步，启动自动恢复全部16位，未完成“先一位成功后再其余”的人工分段与逐人请求级耗时。这是明确验收缺口，已记报告，未重新围栏补造。

必要修正：7b9ec33e9阻止原地恢复完成后提前自动清旧副本；7b113b6fa修复多联系人停车/换快照后的增量饥饿；f687753be补旧读取器持久能力兼容门禁。报告与现行规格提交a607ab66d：docs/verification/sync-simplification-03-live-recovery-20261107.md。

验证：node --test backend-ts/test/sqlite-history-incremental-snapshot-follow.test.mjs backend-ts/test/sqlite-history-in-place-recovery.test.mjs（20/20）；兼容相关组21/21、后台npm run typecheck通过。全量同环境perl -e 'alarm 600; exec @ARGV' -- npm test -- --test-timeout=60000 --test-force-exit：基线2208/2158pass/49fail/1cancel，最终2214/2165pass/48fail/1cancel；逐用例新增失败0，不称全绿。Standards0；Spec原1项已修正复审关闭。

三份真实SQLite操作前备份和完整性校验ok，路径/逐人数字/命令见报告。主工作区源码未改，当前开发App由独立工作树pnpm run dev运行，CLI已配套v3。不打包、不push、不发微信消息、没有真实模型生成；16:45原生细分原因仍未复现。05只出清单等待用户确认，06仍依赖05，08不执行。
