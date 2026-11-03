# 后台记忆调度扫描优化验收（2026-11-03）

## 范围与行为

承接 [前台读取通道隔离](foreground-read-channel-isolation-20261103.md)，本轮优化后台记忆排队与处理状态统计。名称局部 OCR、联系人匹配和读取授权规则保持，不增加数据库、迁移或持久计数器。

- 待处理统计只投影消息与来源元数据；内置文字在 SQL 内判定非空，图片批量判定当前文件及来源资格，不返回正文或计算内容摘要。
- 同一只读动作复用完整／待处理候选及内容资格，同时得到历史与增量统计；动作结束即释放，不跨事务缓存资格。
- 已分配目标由同一联系人集合一次物化，消除逐消息扫描该 owner 全部 `run_input` 的相关子查询。实际领取批次的查询同步修改，保留空目标与既有分配语义。
- 正式调度通过 `scheduleContacts`／`scanSchedule` 每批最多 32 人取得两类到期提示。联系人事件定向刷新，启动、范围变化与 30 秒兜底全局刷新；内存仅保存提示，真正建轮仍从 SQLite 重验。
- 保留原有增量门槛、历史轮转、小批让出、暂停、未知回执及删除／来源资格。旧内容插件没有 `availableMany` 时回退原 `snapshot`，仍会加载其所需的完整同范围消息；来源记录 ID 与旧路径一致。

## 同一负载的前后对照

使用已有本机数据库，以 `readOnly`、`query_only` 和同一只读事务固定数据及 `now`，依次运行修改前和修改后动作；输出仅含计数、耗时与结果等价标志，不输出联系人、正文或身份。基线取自本轮开始时的实现，包含当时已有的历史队列优化。未执行写动作或模型请求。

| 工作负载 | 修改前 | 修改后 | 结果 |
| --- | ---: | ---: | --- |
| 完整调度读取轮次 | 20745.4ms，211130 次 SQL | 1891.8ms，8605 次 SQL | 两类名单及下次到期时间完全一致 |
| 上述轮次最慢 SQL | 5445.1ms | 213.8ms | 新版最慢 32 人批次 415.1ms |
| 处理状态 `readSchedule` | 13132.7ms，183156 次 SQL | 2025.0ms，6407 次 SQL | 完整结构完全一致 |
| 调度轮次返回正文行数 | 170336 | 0 | 内置文字／图片统计路径 |

合成的 6000 个已分配目标加 1 个未分配目标场景，核心读取从约 3662ms 降至 11.6ms；待处理数仍为 1，完整元数据仍标出 6000 个已分配目标。查询计划确认分配集合只构建一次，不再逐候选扫描。

这些是单机现有数据的读取测量，不是耗时上限。按联系人组批不能给单个大联系人的耗时设置硬上限。同进程前后测量的峰值 RSS 是累计峰值，不能据此宣称内存下降；缓存限于当前读取动作，不保存正文快照。

## 实际开发 App

通过 `pnpm --dir desktop run dev:status` 核对并复用当前热更新开发实例；未打包、未启动额外实例。Computer Use 打开“记忆”，选取已有验收联系人，展开“记忆处理状态”，实际显示历史待提取数量及历史／增量分别排队说明。未触发手动提取、候选生成、外部消息或模型请求，未保存私人界面截图。

正式认证 HTTP 入口 `/api/memory-processing/schedule` 两次返回 200，耗时 1800.6ms、1702.2ms。相邻 `/api/sync/status` 仍耗时 5252.2ms；该路径的同步覆盖／可见性统计不在本轮记忆调度修复范围，不宣称整个后台状态查询都已变快。前台 OCR 隔离沿用上一轮有效证据，本轮没有更改其实现。

复用的开发进程保留；本轮未产生 App、原生编译或运行时 staging 副本，无此类新增占用需要清理。短期只读测量进程均已结束，合成测试目录由夹具回收，端侧对照脚本与汇总日志保留作复核，不提交私人数据。

## 自动验证与接口依据

相关 17 个模块共 **71/71** 通过，覆盖轻量投影、Unicode 空白及 NUL、图片／来源部分失效、首次来源与当前来源、baseline、已分配目标、删除代次、同轮缓存、定向唤醒、在途再次唤醒、到期重验、失败退避、历史公平和步骤间增量准入。测试使用合成资料与模拟模型；不覆盖真实模型输出质量。

实际命令（在 `backend-ts/`）：

```sh
node --test --test-concurrency=4 \
 test/sqlite-memory-schedule-inputs.test.mjs \
 test/sqlite-memory-schedule-scan.test.mjs \
 test/sqlite-memory-unified-scheduler.test.mjs \
 test/sqlite-memory-unified-runtime.test.mjs \
 test/sqlite-memory-l1-scheduler.test.mjs \
 test/sqlite-memory-dual-scheduler.test.mjs \
 test/sqlite-memory-fair-turns.test.mjs \
 test/sqlite-memory-history-auto.test.mjs \
 test/sqlite-memory-history-schedule-budget.test.mjs \
 test/sqlite-memory-content-availability.test.mjs \
 test/sqlite-memory-content-upgrade.test.mjs \
 test/sqlite-image-memory.test.mjs \
 test/sqlite-memory-scheduler-isolation.test.mjs \
 test/sqlite-memory-verified-results.test.mjs \
 test/sqlite-source-reference-batch.test.mjs \
 test/sqlite-history-source-epoch-deletion.test.mjs \
 test/sqlite-history-source-holder.test.mjs
pnpm run typecheck
```

桌面 `pnpm run typecheck`、`git diff --check` 通过。独立审查发现并补齐旧插件候选的来源记录 ID，其他重点未发现可行动问题；该结论不替代运行验证。

另导出仅含本轮暂存改动的源码快照复跑，**71/71** 通过（21.20 秒），直接调用已安装 TypeScript 的 `tsc --noEmit` 通过。初次导出遗漏根锁文件及技能目录，分别导致来源身份与 JSON 导入检查失败；补齐跟踪文件后通过。快照中的 `pnpm` 曾触发安装自检，被既有构建脚本策略拒绝，随后改为直接调用现有编译器；未放开策略或修改依赖声明、锁文件。临时源码快照和暂存隔离副本验收后删除。

沿用已核对的 DSH `0.2.1-rc.2`、Cordis `4.0.5` 和既有 `ctx.plugin`／`ctx.effect` 生命周期，不新增第三方接口。SQL 使用现有 SQLite 执行与只读合同；新 `availableMany` 是本仓库内容插件的可选方法，执行时仍使用原 `snapshot/prepare` 复验。
