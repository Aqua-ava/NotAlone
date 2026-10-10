# Python 后端

本目录是独立的 Python 项目，提供联系人、导入、记忆、检索、候选回复、同步和后台任务。HTTP 入口在 `src/notalone/server/`；其他领域及持久化模块同属后端。

```text
backend/
├── src/notalone/       Python 包及 CLI、HTTP 入口
├── tests/              合成夹具、单元与集成测试
├── database/           PostgreSQL 版本化迁移
└── pyproject.toml      依赖、包配置与命令入口
```

## 开发入口

以下命令从本目录执行（从仓库根目录先 `cd backend`）：

```bash
conda activate NotAlone
python -m pip install -e .
notalone-server --help
```

运行配置仍放在仓库根目录的 `.env`，启动命令会从当前目录向上查找已有文件；已有 shell 环境变量优先。首次配置与 owner 初始化按 [仓库说明](../README.md)在仓库根目录执行；根 `.env` 尚不存在时，不要直接从本目录初始化，否则既有默认规则会写入当前目录。

如需从本目录首次初始化，必须在该次命令前加 `NOTALONE_ENV_FILE=../.env`，显式把读取与写回位置指向根配置；同样可指定其他受控配置路径。迁移命令不自动读取 `.env`，需显式提供数据库连接。不要将配置、聊天、备份或数据库文件放入源码目录。

本地 HTTP 服务的手动启动入口为 `notalone-server`；首次身份初始化、导入、同步及模型配置见 [仓库说明](../README.md)。启动服务前须按 [迁移说明](database/README.md)完成目标库的版本检查。

仅构建 Python 包用于打包验证，可在本目录执行 `python -m pip wheel --no-deps --wheel-dir dist .`。SQL 迁移及原生探针仍按仓库中的独立入口管理，该 wheel 不代表完整桌面安装包。

## 验证

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 python -m unittest discover -s tests -v
```

数据库集成测试只使用名称以 `_test` 结尾的合成测试库；设置 `NOTALONE_TEST_DATABASE_URL` 可指定隔离库。真实模型冒烟另需显式凭据，不属于离线验证。

会话授权管理沿用认证回环 HTTP 和当前运行 owner/微信账号范围：`GET /api/sync/cli-bindings` 只返回 active 绑定的 `binding_id/contact_id/conversation_locator/display_name/status`，包含 CLI 列表消失的绑定。`POST /api/sync/cli-bindings/revoke` 严格接受 `{contact_id,binding_id}`，复核完整范围后在 SyncHost 同一 cycle 锁中幂等撤销。最多等待 4 秒取得锁，超时返回 `409 cli_binding_revoke_busy` 且不执行迟到撤销；跨范围为 `404 cli_binding_not_found`，其他失败不会包装成功。成功响应后不再新增该绑定的 tail，历史资料与绑定记录保留。批量 confirm 仍为追加；可选 `observed_display_name` 核对服务端最后复读的名称，任一不符整批拒绝。携带该字段且省略 `contact_id` 的明确新建选择若在最终确认时已存在 active 绑定，同样整批返回 `409 cli_binding_rejected` / `selection_stale`，不静默复用既有联系人或部分创建其他项。显式指定相同联系人仍可重放，原 `display_name` 仍可自定义，未提供新字段的既有调用兼容。此检查不锁住外部微信后续改名，后续变化仍需撤销后重新确认。

`tests.integration.server.test_binding_consent` 自建并回收随机 `_test` 库、正式迁移、生产 `notalone.server.command` 和合成 CLI，只通过真实 HTTP 观察授权与历史结果，并在 CLI 进程边界核验 tail。不依赖默认测试库、私人 `.env`、真实微信或模型；既有测试的 `NOTALONE_TEST_DATABASE_URL` 仍需显式隔离。

桌面端代码在 [desktop/](../desktop/README.md)，Mac 平台能力在 [native/macos/](../native/macos/README.md)。后端不会发送外部聊天消息，联系人范围和用户确认规则见 [产品领域文档](../CONTEXT.md)。

文字同步的一次性 `tail`、单会话 `tail_follow` 和全局会话事件流均显式传入 `--include-media-paths false` 与 `--strict-read-only`，保留非文字事件的最小计数及水位。v1.6.25 同二进制 schema 声明媒体路径补齐默认开启；严格只读不能代替这一关闭参数。外置 CLI 不支持参数时按既有命令错误失败，不回退到媒体默认。75 项相关合成回归通过；真实配置初始化、事件/游标兼容、媒体查询是否关闭及其他 CLI 版本兼容仍需运行验收，见[任务 20](../.scratch/mac-desktop-app/issues/20-mac-app-delivery.md)。

## 真实微信单联系人验证边界（2026-10-10）

固定 CLI v1.6.25 在授权单联系人、严格只读与无网络的本机隔离下，已确认用户测试新事件到达。生产有界轮询引擎与正式 PostgreSQL 仓储在独立随机 `_test` 库验证：入库 1 条，重启与重新开启同步新增 0，关闭期间 CLI 调用 0；临时库已清理。未使用模型或业务库，未发送消息。此轮不证明全局会话事件流、异常重启、双联系人切换或完整桌面闭环。

单次 tail 使用完整 JSON envelope，以实时来源、精确会话、无警告和 has_more=false 确认检查完成；空结果不推进游标。不能证明来源或存在后续页时保留未完成状态，当前不执行分页。follow 仍使用 JSONL。相关公开接口与后台合成回归 85/85；现场范围及剩余项见[验收台账](../docs/macos-app-permissions-and-errors.md)。

2026-10-10 追加故障验收：对本轮自有且已核对可执行文件的单次tail进程中断，生产适配器报告cli_command_failed；消息数0、游标不变。显式retry_backfill后补回1条、补齐错误清除；后续重启/重开不重入，关闭零读取，自有进程和临时库均清理。这是单次读取故障后的显式恢复，不能替代全局流自动退避或App退出验证。该记录属于入口修复前的单次读取验收；最新全局流入口与结果如下。

## 当前全局流诊断与恢复（2026-10-10 23:55）

鉴权follow-smoke接口现已接到正式后台引擎，开始/中断/状态不调用旧fallback或OCR。结束仅结束诊断，正常同步继续；关闭总开关或宿主停止才停止读取。全局流失败保留有界轮询并在3秒起、最长60秒的指数退避后重连，沿用全局cursor；明确不支持的CLI不自动重试。解析线程退出与进程回收分离，回收失败可重试，不能丢失旧进程引用后继续拉起新流。

7个相关unittest模块120/120；真实固定CLI与生产引擎、SyncHost、控制器、进程内鉴权路由和独立PostgreSQL通过中断/意外退出自动恢复、恢复后新消息入库及去重、结束诊断继续同步、关闭零读取。所有测试进程和临时库已清理。正文仅用户确认的单联系人测试文字，OCR和模型未运行。未覆盖网络HTTP监听、常驻后台线程、最终Electron退出、双联系人切换和中断期间新消息；完整范围见[运行手册](../.scratch/native-app-backend/follow-smoke-runbook-20261005.md)。
