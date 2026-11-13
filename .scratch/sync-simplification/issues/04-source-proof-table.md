# 并表：围栏 + 租约 + 范围折叠为每联系人一行 source_proof

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 02

按 [spec](../spec.md) 阶段 2 与第 3 节目标模型。

## 要做

- 新增 `source_proof`（账号键、会话键、来源代次、物理目标摘要、状态 `ok`/`needs_confirmation`、最近核对时间）。迁移：有围栏 → `needs_confirmation`；无围栏且范围匹配 → `ok`。
- 全部读取入口统一走一个“核对来源”函数，消除多入口各自判围栏；读写路径切换完成后删除 `history_continuity_fence`、`history_continuity_scope`、`history_guard_lease` 三表及其读写代码。
- 原生快照守卫保留为进程内保护，不再持久化租约。
- 迁移带备份说明与回滚方式（库版本升级后旧代码 `schema_too_new`）。

## 验收

- 迁移前后每联系人状态一致（围栏 ↔ `needs_confirmation`）；迁移幂等，在 1.2 GB 级副本上用时可接受。
- 02 的全部验收用例在新表上仍通过；重启 ≥5 次围栏数不增加。
- 删除/清空/排除相关既有测试通过；全量对照无新增失败。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments

## Answer

2026-11-07 完成，State=resolved。独立工作树：/Users/local-user/Documents/learn/NotAlone-sync-simplification，分支 codex/sync-simplification。

结果：
- 迁移46将围栏、范围、持久租约三表折叠为 owner_id + contact_id 唯一 source_proof，保存账号/会话/代次/物理目标、ok或needs_confirmation、实际核对时间。旧围栏优先保留，匹配旧范围才ok，未知身份保守待确认；迁移不伪造checked_at。
- 原生守卫仅驻Worker内存，SQL提交后发布，失败/序列化错误/busy重试回滚；重开不恢复守卫。本机合法资料不依赖活守卫，新外部读取仍完整核验授权、来源和删除边界。
- 全部正式读写入口切至新事实，旧三表DROP。未完删除目标迁移保留精确身份并重建正式holder列表；整联系人/账号删除收集proof与实际guard并集，排空后一起清除。补齐无proof及1025联系人删除、真实账号变化围栏与安全诊断。
- ADR-176、现行微信同步/隐私删除/领域数据、术语及模块说明已同步；历史迁移16/18等校验和不改。

已运行命令与证据：
- docs/verification/sync-simplification-04-test-coverage-20261107.md：TDD失败→通过、19事务、71恢复认证、34本机资料、118删除综合、57正式渠道、32诊断、17真实旧结构升级等记录。最小检查后逐级扩大，未降低断言、阈值或测试分类。
- backend-ts和desktop分别 npm run typecheck 均通过。根pnpm递归受工作树依赖链接的任务状态路径限制，未改主树依赖。
- backend-ts执行 perl -e 'alarm 600; exec @ARGV' -- npm test -- --test-timeout=60000 --test-force-exit：最终2208项，2159通过、48既有失败、1既有取消，296.45秒；对照02逐文件/用例新增失败0。源码/测试804文件冻结摘要前后一致。并发时一次750ms时限波动完整保留，基线和当前最小均过，负载退出后同代码全量通过该项，未改时限。
- sync-source-proof-migration.mjs 两份3.20GB副本：逐联系人矩阵、幂等、旧45 schema_too_new、45前像可开均过。
- sync-recovery-repeat.mjs --rounds=6 --transient-retries=4：五次重开含一次自有宿主/CLI SIGKILL，失败/重试0。278有效范围待确认数始终0；总needs61→2（两位原本未核验绑定保留）。
- sync-saved-metadata-counterexamples.mjs 存档/当前原生元数据模式各6/6：账号、会话、代次、分片、表实例、文件身份变化均新增needs，正文/锚点方法0调用。
- 普通SqliteStorage.open默认60秒预算另用新副本验证：45→46为24,687ms；精确清理自有一次性3,199,328,256字节副本，源码导出0残留。
- docs/verification/sync-simplification-04-copy-replay-20261107.md 记录完整命令、时间、矩阵、失败现场及回滚方式。Standards/Spec独立审查未解决问题均0。

数据影响：
- 迁移本身绑定、规范化消息、goal/capture和九类派生/引用逐项不变；96→94表，280条proof，278授权仍允许、2未核验仍拒绝。
- 在线演练只核2682个有界锚点与增量续读，旧范围正文记录0；消息407139→407276（+137），绑定831和九类引用不变。goal/capture下降仅既有无引用空任务/抓取保留策略，不做存量旧绑定副本或规范消息删除。
- 原指定备份和45源副本stat不变；真实业务库零写入，真实15位围栏未动，不改主工作区源码，不重启/切换真实App或读取器，不点修复，不发消息/模型请求，不打包、不push。

剩余风险：
- 并发I/O下正式Worker打开70.8/78.2秒超过App60秒预算，普通客户端空闲负载24.7秒已过；真实应用启动/界面未验收，不能宣称重负载必然成功。
- schema46不能由旧45代码打开；回滚须用受控45前像，不能覆盖升级后新增资料或删除决定。
- 48项历史失败/1取消仍存在；历史升级夹具依赖本机Git可读固定02完整提交。真实库恢复/旧副本清理/观察属03/05/08。
- 06保留open，依赖05；不提前删除旧审计和删除保护。

本地提交：adfdaa388bd55f34fb0667bc519aed79b2fc95d4

提交后完整可达历史及工作树检查：node scripts/check_public_history.mjs --ref HEAD --working-tree，issues=0；工作树干净，未push。
