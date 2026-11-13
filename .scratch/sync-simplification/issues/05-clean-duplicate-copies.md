# 存量旧副本清理（执行）

Triage: ready-for-human
State: resolved
Type: task
Blocked by: 03

02 之后不再产生新副本，对现有多余副本做一次性清理。工具已就绪（ADR-175，`backend-ts/scripts/maintenance/superseded-inventory.mjs`、`clean-superseded-history.mjs`），涉及用户数据删除，必须用户确认。

## 要做

1. 重跑只读清单（16 位联系人的可清/保留消息条数、媒体文件数与字节），给用户匿名汇总。
2. 用户确认后：退出应用、备份真实库、运行离线脚本（`--confirm-clean` 与名单数量一致），清理后重跑清单核对。

## 验收

- 清单与实际清理结果逐项一致；被记忆、候选、整理条目引用的旧消息保留，引用方行数不变。
- 每位联系人只剩现行副本（加被引用的少量旧消息）；库体积回落，记录前后大小。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments

## Answer

用户明确回复“删除”后，已按确认的16位完整ID逐项复核清单一致，正常退出App，备份SQLite+媒体，运行官方离线脚本完成。28批、476.1秒、未结案0、退出码0，integrity/FK均ok。

消息122223→43550，恰删78673；保留现行41011+受保护旧2539。媒体1564/1742737390字节→823/927457164字节，恰删741/815280226字节；逐位与确认清单一致。九类引用及model_call全行内存摘要比较一致，调用仍367；绑定50/有效16不变、source_proof16ok，无新围栏。

备份backups/superseded-cleanup-05-20261107含SQLite和整个媒体目录，独立完整性ok、消息122223、媒体1564/1742737390字节；备份保留。离线备份SQLite1356091392→清后1013026816字节。清后可清消息/媒体均0，旧保护2539，清理请求0、28维护操作completed。

命令：node backend-ts/scripts/maintenance/clean-superseded-history.mjs --user-data=<真实目录> --confirm-clean=16 --contacts-file=<确认名单> --backup-dir=<全新含媒体备份目录> --timing；前后重跑superseded-inventory.mjs及实文件/逐表行一致性核验。执行结果本地提交5cdfb57e3。完整命令和逐位数字见docs/verification/sync-simplification-05-inventory-20261107.md。未改主源码，不打包、不push、不发微信消息；真实模型生成未调用。06在上述核对完成后开始，08不做。
