# 删除账本规模与空间回收验收

日期：2026-11-11；分支：`perf/ledger-acceptance`；仅在指定隔离工作树工作。

## 真实库副本现状

- 指定真实库仅经 `sqlite3 "file:…?mode=ro" ".backup …"` 读取复制到仓库外 mktemp 目录；managed、managed/sqlite 为0700，数据库为0600。
- 副本实际 user_version=50，已无逐行目标；经用户选择，按现状验收，不降级或重造真实账本。47→48缺少真实库前后证据。
- 页大小4096字节；全部331个操作均为completed，其他状态为0；非空target_summary为331个，bucket总和1,607,680，以下各阶段保持不变。

| 阶段 | user_version | deletion_target | page_count | freelist_count | 文件字节数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 只读备份基线 | 50 | 0 | 147,479 | 0 | 604,073,984 |
| 项目客户端open后 | 50 | 0 | 147,479 | 0 | 604,073,984 |
| deletion.compact后及关闭后 | 50 | 0 | 146,096 | 0 | 598,409,216 |

- expectedDatabaseId仅从副本database_instance内存读取；正式open耗时3,361.351ms，没有执行迁移。
- compact耗时3,413.017ms；另跑完整storage.check耗时1,579.343ms，integrity_check及foreign_key_check均通过。
- 当前文件已约604MB且freelist为0，并非仍有约600MB空闲页滞留的1.1GB快照；本次compact再缩小5,664,768字节。
- 摘要总和与先前约160万行吻合，属于间接数量证据；背景330个操作与当前331个不同，不能声称逐操作迁移守恒或断定此前何时压缩。

## 合成百万行47→48

- 复用deletion-ledger-prune-legacy-registry创建47库，仓库外临时可信registry仅保留原迁移至48；未改任何迁移、worker或公共registry文件。
- 通过可信注册动作灌入1,000,005条纯合成已清除目标，归属330个completed操作；三类bucket各333,335条，不含真实资料。

| 阶段 | deletion_target | completed | 非空摘要 | bucket总和 | page_count | freelist_count | 文件字节数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v47 | 1,000,005 | 330 | 不适用 | 不适用 | 78,129 | 0 | 320,016,384 |
| v48及关闭后 | 0 | 330 | 330 | 1,000,005 | 78,137 | 77,708 | 320,049,152 |
| compact后 | 0 | 330 | 330 | 1,000,005 | 421 | 0 | 1,724,416 |

- 正式open仅47→48耗时2,977.783ms，包含Worker、身份核验、迁移及完整校验，未单独计量迁移SQL；仅合成灌入动作放宽至600秒，open和compact使用默认预算。
- 迁移清零且三个bucket精确守恒；文件增加32,768字节，关闭也未缩小。compact耗时26.866ms后才回收；追加完整storage.check耗时1.504ms，integrity/FK均通过。

## 回收路径与方案边界

- actions.ts:221–228执行checkpoint(TRUNCATE)→VACUUM→checkpoint→完整integrity/FK→inspect；checkpoint busy、空闲页、WAL/journal残留或未知辅助文件均拒绝，活动连接的SHM可保留。
- service.ts:28–46、98–106仅在仍需清理的advance/advanceBatch封存后压缩、再核验；completed重试提前返回。媒体启动恢复仅推进未完成清理；全completed迁移后没有专门启动回收路径。
- maintenance预算为max(600,000ms, ceil((DB+WAL)/4MiB)×1000)，普通动作15秒、打开60秒；维护在唯一写者Worker内同步执行且不可抢占。
- 候选条件为free/page>0.2且free×page_size>50MiB；真实副本不达标，合成迁移后达标。但服务层观察队列空闲无法阻止随后回复写请求等待整次VACUUM/校验，也不能代替长读者排空。
- 未实现自动触发：安全方案需要宿主维护窗口、写者/长读者协调和存储调度支持，超出仅deletion目录可改边界，涉及禁止的worker等存储底座；按原第5项停止实现。未新增迁移或修改禁止文件。
- 现有运行时先compact再verify，verify完成时才剪除本次目标，因此这部分页也须后续压缩回收；阈值仅能控制较大的残留，不会保证每次结案后freelist恒为0。

## 验证、清理与限制

- pnpm install通过；先运行sqlite-deletion-ledger-prune.test.mjs：2/2通过；再在backend-ts运行node --test test/sqlite-storage*.test.mjs test/sqlite-deletion*.test.mjs：64/64通过（包含前述2项），无跳过。
- git diff --check通过；独立只读核查维护调用链与README；初始公开历史及工作区检查issues=0。
- 真实副本和合成库、临时registry/脚本均已删除并复核不存在；未启动桌面、未打包、未写真实应用目录，未输出正文、联系人或行键。
- 仅更新deletion/README和本报告。领域入口引用的architecture/README.md、architecture/current/privacy-deletion.md在本工作树缺失，只记录、不越界补写。
- 风险：没有版本47真实快照，不能据合成耗时承诺真实库迁移耗时；未实现自动回收，也未验证前台并发体验，维护须在受控窗口执行。
