# 原库结构补齐与正常首启

用户已明确授权删除强制搬库和自动备份流程，并在现有数据库原地补齐缺失结构。日常开发继续采用已实现的 `npm run dev`。

## 行为

- 已保存的数据库连接、资料位置和原启动配置保持不变，不复制数据库，不生成更新备份，不改写旧迁移账本。
- 启动仅在已核验的本机数据库上执行缺少的版本化 SQL；账本不匹配、缺少可信基线、有其他连接或更新并发时停止并显示可重试原因。
- 新用户保留 App 自带 PostgreSQL 空库初始化、后续同库复用与认证退出生命周期。
- 移除旧更新界面、创建备份／复制数据库的桌面 IPC 和接续流程；历史备份仍参与真实来源删除清理，不借停用功能保留可恢复的已删除正文。
- 开发模式沿用既有配置和本机库，界面热更新与安全重启保持。

## 验证边界

- PostgreSQL 启动结构接口：合成 059 旧库原地升级、旧字段/身份保持、重复启动不重跑；空库初始化；历史错误/其他连接时无新增结构；无备份产物。
- 桌面公开启动状态和页面：既有资料正常连接，新装设置可见，没有备份或搬库门禁。
- 用户本机数据库：相关隔离验证通过后停止现有开发 App，经授权原地应用缺失 SQL，再用 `npm run dev` 实际连接，核对版本就绪及原配置未变；不查看私人正文，不发送模型或微信消息。

## 不在范围

远端数据库、云端部署、未记录分叉结构的猜测接管、恢复覆盖、删除既有业务资料，以及重新打包正式 App。

## 实际结果（2026-10-17）

- 已删除旧 Main 更新编排、复制／备份 Python 编排、对应界面与创建操作 IPC；历史副本清理和内嵌恢复说明保留。
- `npm test`：类型检查及 150 项 Node／合成进程检查通过；该命令本身不运行真实 App。
- Conda `NotAlone` Python 的 `python -m unittest tests.integration.persistence.test_startup_database tests.integration.persistence.test_startup_diagnostics tests.integration.persistence.test_database_migrations -v`：36 项通过。
- `python -m unittest tests.integration.persistence.test_managed_update_backup_deletion -v`：10 项历史副本真实恢复／删除通过，测试专用随机数据库与临时文件已清理。
- `node --test tests/startup-continuity.test.mjs tests/packaging/managed-runtime.test.mjs tests/packaging/replacement-kit.test.mjs` 的初轮 13 项通过；新增历史门禁、旧后台存活和内嵌恢复说明均已纳入最终 `npm test`。
- 受限 `test:app` 指定 `tests/startup-diagnostics.spec.ts`、`--grep '空库在原连接|保存路径与连接重试并发'`，3 次启动预算内的 2 项实际 Electron／HTTP／PostgreSQL 测试通过（8.6 秒）；仅合成空库，配置原字节不变，无更新目录或搬库收据。
- 用户本机原库经明确授权原地应用 060–072 后只读复验 `ready`；同库身份与数据目录、原记录数量及标识、旧账本、原配置文件均核对保持不变，无备份或更新收据。
- 主 Agent 实际用 Computer Use 打开开发版的“应用配置”，看到“已连接”和“机器环境已就绪”；源码变更后正常退出／重启日志及重连均核对。未选择联系人、未生成候选、未操作微信或申请权限；私人界面未保存到仓库。
- 独立 Standards 与 Spec 审查发现的历史现场、旧后台短连接间隙及恢复说明问题已修复并复审通过。结构核验按 ADR-066 明确限定于可信账本与应用必需表／字段，不另建参考库认证自定义对象。
- 本轮仅复用 `.dev/` 和 `dist/`，未重新打包 `.app` 或复制运行时。前后 `.dev` 约 20 MiB、`dist` 约 3.7 MiB、既有 `out` 约 860 MiB，可用空间约 58 GiB；保留当前开发资源和合成验收记录。
- 本次不认证新安装包、无开发环境机器、微信或真实模型集成；已安装旧包须在后续交付时正常重建。
