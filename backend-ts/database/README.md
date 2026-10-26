# 数据库结构与升级

本目录保存数据库的创建和升级步骤。`migrations/` 中每份 `.sql` 文件是一项结构或数据调整，例如建立联系人表、增加记忆字段、调整查询索引。实际联系人、聊天消息和关系资料保存在 PostgreSQL 中。

新安装按顺序建立完整结构；已有数据库只执行尚未完成的步骤。文件需要保留，因为现有升级流程会核对文件名和内容，不能直接删除、改名或改写已执行的脚本。

## 日常运行

日常开发从 `desktop/` 执行 `npm run dev:status`，先复用当前项目实例，没有实例时才执行 `npm run dev`。

按 [ADR-066](../../architecture/adr/066-in-place-schema-updates-and-database-reuse.md)，App 启动先只读检查原数据库；有缺少的版本时，在原后台已停读、生成已结算且没有其他目标库连接的条件下，原地执行缺少的 SQL，再检查并连接。结构已就绪时不重复迁移。

- 已有配置继续使用原数据库和资料位置；连接失败不能改用新空库。
- 没有既有配置的新安装，由 App 自带的 PostgreSQL 初始化空库。
- 普通启动不创建备份、恢复副本或切换数据库。已有备份仍须保留原归属与删除约束，不能因此自动丢弃。

## 手动检查与结构补齐

使用 Node.js ≥24，从仓库根目录执行。`NOTALONE_ENV_FILE` 指向明确选定的现有配置文件；不要把真实连接串或凭据写入仓库。

只读检查：

```bash
NOTALONE_ENV_FILE='/绝对路径/受控配置.env' \
  node backend-ts/src/schema-prepare-cli.ts --migrations backend-ts/database/migrations
```

入口只核对系统目录、迁移账本、可信基线及必要表／字段，不查询联系人或聊天正文，不调用模型。输出固定 JSON 状态，`ready` 的退出码为 0，其余为 1。

需要补齐时，先退出 App 并确认原后台、Worker 和其他目标库连接均已停止，再执行：

```bash
NOTALONE_ENV_FILE='/绝对路径/受控配置.env' \
  node backend-ts/src/schema-prepare-cli.ts --prepare --migrations backend-ts/database/migrations
```

准备入口只支持明确的本机业务库，不创建数据库或替代库；结果另含 `applied` 文件列表。一个版本的 SQL 与账本记录在同一事务中提交，失败回滚当前版本，之前成功的版本保留。修复失败原因后重新检查并续跑。

## 状态与处理

| 状态 | 含义与处理 |
| --- | --- |
| `ready` | 已通过当前结构检查。 |
| `migration_pending` | 缺少后续版本，满足停读与连接条件后补齐。 |
| `migration_busy` / `database_writers_present` | 存在并发更新或其他连接，先核对并结束占用。 |
| `baseline_missing` / `baseline_invalid` | 旧库缺少可信基线或凭证无效，停止并核验历史。 |
| `migration_history_mismatch` | 文件与已执行账本不一致，停止并核对原版本。 |
| `migration_files_invalid` / `schema_incomplete` | 脚本集合或实际结构不符合当前要求，停止检查原因。 |

这些检查不会自动修复未知历史。不得手写成功记录、修改旧账本、重放已执行脚本或删除业务库来绕过错误。

## 维护迁移脚本

- 文件从 `001_name.sql` 起连续编号，新变化追加新文件；`public.notalone_schema_migration` 保存已执行文件名、SHA-256 和执行时间。
- 只使用受信任的仓库 SQL。迁移由执行器统一管理事务，不得加入自行提交或必须在事务外执行的操作。
- 每个版本单独提交；多个版本不会整体回滚。003 只允许空业务表，部分后续迁移会转换已有数据，因此不能将整个目录作为可随意重跑的 SQL 集合。
- `103_skill_business_state_only.sql` 需要执行器先升级并校验受控 Skill 文件，再删除旧正文结构并提交账本；不能绕开统一入口单独执行 SQL。
- 表和字段的中文注释只描述通用数据契约，不包含真实姓名、微信 ID、聊天正文或凭据。

实现入口为 [`schema-prepare-cli.ts`](../src/schema-prepare-cli.ts)，迁移与账本逻辑见 [`schema-prepare.ts`](../src/platform/database/schema-prepare.ts)；合成 PostgreSQL 回归见 [`schema-prepare.test.mjs`](../test/schema-prepare.test.mjs)。

## 历史旧库

当前执行器兼容带有效凭证的 035 审计基线：核对固定前缀后，只迁移 036 及后续版本，不把前 35 份脚本伪记为已执行。没有可信凭证的旧库或分叉结构须停止核验，当前 CLI 不提供自动接管能力。

旧 Python 迁移、035 接管和旧分支编号记录已从日常操作说明中移除，原文保留在 Git 历史；固定旧实现的恢复方式见[历史测试说明](../test/HISTORICAL.md)。接管约束见 [ADR-032](../../architecture/adr/032-audited-legacy-schema-baseline.md)，不得从当前源码运行已退役的 Python 命令。
