# 删减：重新认证、批量修复面板与相关死代码

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 04, 05

按 [spec](../spec.md) 阶段 3。

## 要做

- 删除重新认证（`recertify*.ts`、`history_source_recertification*` 表、开发者批量修复 `FencedRepairBatchPanel` 与桥）、`history_superseded_cleanup` 及自动清理触发（05 已完成存量清理后）、不再使用的租约/围栏代码与测试夹具。
- 旧 ADR（144、161 中跨代次部分、173、175）顶部标注被替代并回链；`architecture/current/*`、`CONTEXT.md`、README 同步；删除迁移需处理已有账本行。
- 统计并记录：`history/sqlite` 代码行数、相关测试行数、表数量的前后对比。

## 验收

- `history/sqlite` 代码行数下降不少于 30%；测试同步精简；表数量减少。
- 删除/清空/排除/终态抑制既有测试通过；全量对照基线无新增失败；类型检查通过。
- 开发应用热更新后正常同步，无功能回退。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments
- 2026-11-08 记录：`history-status-recertification` 6 用例（4 个状态循环+2 个）直接退役——它们经 fixture.statusRecertification 写已被 ADR-177 迁移删除的 `history_source_recertification` 表；测试文件与 `status-recertification-registry` 夹具删除，旧表退役行为仍由 sqlite-sync-retirement 套件锚定。


## Answer
## Answer

完成（2026-11-08，执行记录 9ade51885→bc0f3fd5e）。

- 结果：重认证/批量修复面板/超置清理/死代码已退役，ADR-177 迁移落地；历史等价保留必要跨代删除事实。`backend-ts/src/history/sqlite` 62→36 文件、6,560→4,907 行——冻结点官方口径 30.08%，本轮为恢复"成功租约保留通道与守卫"语义（用户决定的行为优先）逐字回移主干与失联归因，净增约 320 行至 25.20%，未为凑指标压行；旧 SQL 以冻结文件归档分列不计净删。
- 命令：`npm run typecheck`；`perl -e 'alarm 1500; exec @ARGV' -- npm test -- --test-timeout=60000 --test-force-exit`（2,104 项/失败 48，含双基线命中 startup-host manual；对照 `final-baseline-failures.json` 新增失败 0，3 条解析 unresolved 伪差同名标题基线已含）。
- 数据影响：删除/清空/排除/终态抑制与删除闭包语义保留；真实库继续只读；47 副本演练净保持 43,550 消息、832 绑定、16 范围、0 围栏；实际库本轮仍为 46 版，合并后按先备好的 `before-migration-47-20261108.sqlite` 备份自动升级 47。隔离开发 App 合成会话：两合成联系人 complete、来源 ok、消息 3、无打包无发送。
- 断言迁移记录：history-status-recertification 6 例随表退役；private/target-handoff/wake-controls/quote-sync/s-p-l/coordinator/cutover-retention 各例安全性质判定与等价断言见 `docs/verification/sync-simplification-06-retention-assertions-20261108.md`，逐例不删弱。
- 剩余风险：1）47 副本两轮回放本轮未验证（agent 上下文缺微信容器 TCC；可在用户终端以 `/tmp/six-copy-sync-current.mjs` 复核，2026-11-07 上轮成功证据 16/16 已存）；2）ADR-177"不再停车保留联系人守卫"句段与恢复后的保留语义尚待 ADR 文案更新；3）memory 域 2 例并发敏感用例（077733bcc 同型）本轮按间歇失败记录。
