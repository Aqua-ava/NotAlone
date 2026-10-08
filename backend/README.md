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

桌面端代码在 [desktop/](../desktop/README.md)，Mac 平台能力在 [native/macos/](../native/macos/README.md)。后端不会发送外部聊天消息，联系人范围和用户确认规则见 [产品领域文档](../CONTEXT.md)。
