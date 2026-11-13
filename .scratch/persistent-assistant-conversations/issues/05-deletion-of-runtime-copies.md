# 05：删除流程清除运行文件及恢复副本

Triage: ready-for-agent
State: resolved
Blocked by: 01

规格：[持久助手会话与空闲分段](../spec.md)。

## 交付行为（What to build）

从公开入口删除会话、来源或联系人时，相关 DSH 文件与恢复副本被清理；在途任务、重启和迟到回执不能复活内容。失败可重试，不会误报成功。

## 阻塞关系

- [01：连续生成与重启后恢复同一会话](01-persistent-runtime-resume.md)。

## 验收条件

- [x] 删除先阻止相关恢复和新出站，协调在途任务与文件写者，再清理相关运行文件、分叉、派生索引、缓存和应用管理的恢复副本。
- [x] 删除助手会话清理其副本并保留独立合法的微信来源和记忆；删除来源或联系人覆盖全部受影响会话。
- [x] 保留无关讨论或无正文占位，不因需要重建整段运行文件而误删无关业务历史。
- [x] 不把 SDK dispose、界面隐藏或投影失效误当成磁盘正文已删除；产品清除职责由 NotAlone 管理。
- [x] 清理失败不返回成功、不继续使用未清理状态，重试可收敛；不擅自删除未知目录或用户另存资料。
- [x] 公开删除后真实重启，再读取、明确继续或重放旧键，不能恢复已删内容或重新外发。
- [x] 通过供应商与删除屏障覆盖在途响应、迟到完成、写者冲突及连接切换，候选与渲染状态保持删除边界。
- [x] 删除链验收完成前，正常用户配置不启用未闭环的长期运行日志。

## 验证入口

主接缝走真实公开删除、磁盘检查、同目录重启及再读取；桌面补公开 IPC 删除中、失败、重试和迟到恢复守卫。

## 执行边界

使用隔离合成资料及测试自有进程。先最小红绿，再相关验证与双轴审查；仅开发热更新，不打包、不发微信、不推送远端。

## Comments

- 2026-10-26：用户已确认后发布，尚未领取或实现。

- 2026-10-27：01已验收合入74c18d8，总控领取05，分支codex/persistent-assistant-05、独立工作树persistent-assistant-05/NotAlone。按只读归属报告先05再02；公共生产跨域删除及桌面失败/重试投影均为本票范围。只有完成相关测试、双轴审查和合入才resolved。

- 2026-10-27：实现冻结为 `cdc126537e4c13ca8b11cd92e9aa0e482b44dfcd`；backend45/45、schema8/8、desktop相关105/105及60/60、两端typecheck通过。Standards／Spec双轴审查已启动，仍claimed，未合入前不关闭。真实/合成差异及完整命令见私有diagnostics/ticket05/evidence.md。

- 2026-10-27 Standards：FAIL，P2一项——commit自有写句柄关闭失败未保留占用。Spec：FAIL，P1来源备份清理先失败时未阻断旧SDK正文再出站，P2无turn兼容临时生成未由联系人删除取消排空；两项已用真实生产公开入口/隔离合成供应商复现。原实现Agent已解冻一次修复三项并补正式红绿回归；仍claimed，不开放02写入。报告及复现位于私有diagnostics/ticket05/review-*.md与review-reproductions.log。

- 2026-10-27：修复提交 `9848f2b0b907995d2ac5e4b7e64124f751fb6dbb`；正式合同0/3→3/3，scope补3场景通过，相关backend44/44、desktop34/34、两端typecheck及public-history通过。Standards复核PASS；Spec复核PASS并独立5/5。已派专职merger合入及最小集成验证，尚未resolved。来源删除失败期保守owner级暂停恢复/生成，只读历史和无关业务/档案保留；完成重试后解除。

- 2026-10-27：双轴复核通过后非快进合入 `b9cbd0af27603526b2c9ff6d5f6cf4a6e07d770b`，集成backend20/20、desktop14/14、双端typecheck、diffcheck和提交后public-history零问题。验收及合入完成，标记resolved。真实App验收及正常配置启用仍待07。

## Answer

已合入b9cbd0af27603526b2c9ff6d5f6cf4a6e07d770b（cdc12653、9848f2b0）。三项审查漏洞已正式红绿修复，原轴复核PASS，Spec独立5/5；相关backend44/desktop34，集成backend20/desktop14及双端typecheck/public-history通过。真实生产公开Host/官方DSH/隔离PG与网络验证来源、讨论、联系人/账户删除范围、写者排空、失败重启重试、应用管理恢复副本及未知目录保留；Main/preload删除失败/404/重试守卫通过。证据在私有diagnostics/persistent-assistant-20261026/{ticket05,integration-05}。source删除未完成时保守暂停同owner恢复/生成，只读历史与无关资料保留；正常配置启用和整套实际小窗在07验收。
