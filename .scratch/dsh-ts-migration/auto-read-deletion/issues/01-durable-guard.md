# 01：自动同步删除抑制窄前置

Triage: ready-for-agent
State: open
Type: bug
Blocked by: none
Spec: ../../spec.md

## 目的与依据

19真实PG对照已证实：冻结Python及当前TS删除最新观察来源后，可靠游标修复回退，新的capture可恢复已删消息。本票为既有删除不复活目标的必要窄修复，不替代17整体删除任务。依据../../incremental-sync/deletion-replay-evidence.md、../../incremental-sync/root-deletion-contract-review.md、../../incremental-sync/deletion-contract-options.md及现行privacy-deletion。

## 边界与验收

- 先读锁定DSH官方文档源码0.2.1-rc.2/687f282e8625c6b8d11ff58211a90524be2e4317，判断业务模块与宿主生命周期边界，不改DSH核心。
- 只保留现有规范消息稳定身份对应的无正文抑制事实，不存正文/文件hash/昵称，不为无稳定身份资料做语义猜测。
- 删除排队请求、直接来源删除、观察删除在既有contact→owner锁事务登记；失败原子回滚，实删幂等补，不能等Worker结束才防复活。
- 两个Python自动保存入口和TS增量/过渡历史消费同一事实；原始处理收据、引用、提取意图、通知同步过滤，cursor仍按实际CLI页前移。
- 保留其他有效来源消息；明确重新预览确认导入可以创建新来源，不恢复旧UUID/证明。普通重启/总开关/一般重绑不作为恢复已删内容的授权，不新增永久封禁或恢复历史功能。
- 联系人/账户整体删除级联清理本表；保留18排除，核验受管备份原删除/恢复门禁。不能回填已无稳定身份的历史删除，明确升级限制。
- 合成PG验证排队窗口、多来源、并发、失败回滚、两个自动入口、新capture/历史/重绑、全过滤/混合页及无正文收据、显式新导入、整体删除。
- 新schema与HostStorage严格门禁及升级测试同一窗口应用，未知版本仍拒绝。双轴审查、最小相关测试和本地提交后供19集成签收；不据本票宣称17完成。

## 并行与落盘约束

最初只在本目录scratch准备精确patch与合成验证，等待主协调授权schema短窗口；不能直接修改产品/迁移。候选109分配给本窄修复，05尚未落盘模型台账顺延110，最终文件及门禁由根原子协调。Python删除/观察存储及新抑制模块归本票；TS sync-incremental-store*目前19独占，本票先给消费端patch不得覆盖；host/app/legacy当前21独占。App锁定，不启动、不打包；仅合成随机_test库，不真实资料/模型、不push。

## Answer

尚未执行。
