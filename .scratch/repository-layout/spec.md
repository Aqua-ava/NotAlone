# 前后端目录整理

日期：2026-10-08

基线：`71807c5288f8e82afcb44d7f2d325dfbe7214ad8`

## 用户问题与目标

用户已选择 TypeScript + React，未来支持 Mac 与 Windows，并要求先清理旧 Swift 主界面，留待重新设计 UI。本次确认整理前后端目录，让 Python 后端、未来桌面端和平台原生适配的职责及工程入口清晰。

## 解决方案

```text
backend/
  src/notalone/       Python 领域逻辑、HTTP 服务及后台任务
  tests/             Python 单元与集成测试
  database/          版本化 SQL 迁移及说明
  pyproject.toml     Python 依赖与命令入口
desktop/             未来 TypeScript + React 桌面端，本轮仅说明文件
native/macos/        现有 Swift 截图、OCR 与前台会话定位探针
website/             独立静态网站
scripts/             仓库级安装及部署脚本
docs/                工程与操作说明
architecture/        架构、领域约束及 ADR
```

## Implementation Decisions

- 整体移动 Python 源码、测试、SQL 和项目配置；保留包名、业务模块、HTTP 协议和 CLI 命令。
- 原生探针整体移动到 `native/macos/`，保留其内部目录、Swift Package、Xcode 引用、权限和签名行为。
- `.env.example` 与本机 `.env` 继续位于仓库根目录；不读取或移动真实配置、联系人、消息、备份及业务数据库。
- 修正安装入口、当前文档路径和可点击的源码链接；历史任务与过去执行的命令不批量改写。
- `backend/README.md` 提供独立 Python 项目的打包说明及运行入口；根 README 作为仓库总入口。
- 旧库接管的备份目录仍须位于整个仓库之外，不能因 Python 下移一级而缩小保护范围。

## Testing Decisions

- 验证接缝为现有 CLI、Python 包、迁移入口、公开旧库接管函数和原生探针测试。
- 针对搬迁造成的仓库外备份判断风险，在公开 `adopt_legacy_database` 接缝增加回归：拒绝仓库内、`backend/` 外的备份，并保持目标库未接管。只使用用例拥有的随机 `_test` 数据库与自动清理的合成备份。
- 先观察该回归失败，再修正目录判断；运行相关迁移测试及完整后端测试。
- 用合成临时目录核验从仓库根目录和 `backend/` 定位同一根 `.env`；不读取本机真实配置。
- 核验可编辑安装与打包、脚本语法、原生 Swift 测试、自检及文档链接。验证不启动 App 或微信采集，不改 TCC。
- 完成 Standards / Spec 两轴审查后，仅为本任务创建本地提交。

## Out of Scope

- 不创建 React UI、Electron/Tauri 工程、Node 依赖或桌面运行入口；`desktop/` 只有后续职责说明。
- 不迁移真实数据、不执行正式库升级、不改变同步、联系人或用户手动发送边界。
- 不修改 SQL 迁移内容、不改变原生探针权限或签名策略、不替换本机正在运行的应用。
- 不实现 Windows 微信适配，不推送或创建远端 PR。

## 验证记录

### 实现结果

- 按约定整体搬迁 Python 与原生探针工程；新增后端与未来桌面端说明，未创建 UI、宿主或 Node 依赖。
- 安装脚本、工程入口、当前架构链接与源码引用已更新；36 份 SQL 的 Git blob 摘要与固定基线完全一致。
- 旧库备份的路径保护仍覆盖整个仓库；配置查找算法未改变。后端说明明确首次根配置的前置条件，以及在 `backend/` 初始化时单次使用 `NOTALONE_ENV_FILE=../.env`。

### 实际验证

Python 命令均先初始化 Conda shell 并激活 `NotAlone`。测试禁用真实 `.env`，模型凭据为空；仅使用本轮拥有的合成测试库，不启动真实服务或微信读取。

1. `python -m pip install --no-deps --no-build-isolation -e ./backend`：通过，既有环境的可编辑安装已指向新后端目录。
2. `python -m pip wheel --no-deps --no-build-isolation --wheel-dir <仓库外临时目录> ./backend`：通过；`notalone-server --help` 与 `notalone-front-sync --help` 正常。
3. 在 `backend/` 运行公开接管回归 `tests.integration.persistence.test_database_adoption.DatabaseAdoptionTest.test_backup_outside_backend_but_inside_repository_is_rejected`：搬迁后先出现预期失败（未拒绝备份路径），恢复整个仓库保护后通过；同次 2 项运行配置测试通过。合成目录与测试库自动清理。
4. 在仓库根目录运行 `python -m unittest discover -s backend/tests -t backend -q`：1189 项、3 项跳过、0 失败，耗时 235.392 秒。先为随机 `notalone_layout_*_test` 应用新目录的 36 个迁移；测试结束清理该库。日志包含合成 HTTP 断连、未关闭流的 `ResourceWarning` 及故障注入的 Skill 拒绝信息，不代表测试失败，本轮未扩大到处理这些既有测试噪声。
5. 用仓库外合成目录验证：已有根 `.env` 时，根目录与 `backend/` 查找和写回同一配置；尚无配置时，在 `backend/` 单次指定 `NOTALONE_ENV_FILE=../.env`，首次写回根配置，未生成 `backend/.env`。两种情况均保持权限 0600。
6. `swift test --package-path native/macos --scratch-path /tmp/notalone-layout-swift.DoAyex -q`：35 项通过，CLI `--self-test` 通过。普通缓存首次构建复现旧绝对路径 PCH 错误；按已更新台账执行 `swift package --package-path native/macos clean` 后，`swift test --package-path native/macos -q` 的 35 项与默认构建 CLI 自检均通过。只清理 SwiftPM 自动缓存，未清理独立 `build/` 产物。
7. `zsh -n` 检查仓库安装、官网部署及两个原生构建脚本：通过。变更文档的相对链接检查、生成目录忽略规则与 `git diff --check` 均通过。

### Standards

规范审查与后续说明复审：0 项硬性违反、0 项 code smell。只读审查未访问私人配置或重复运行项目。

### Spec

初评发现 1 项：没有根配置时，从新后端目录首次初始化可能写入 `backend/.env`。已明确根目录初始化或单次显式根配置路径，并以合成目录验证；复审剩余 0 项。

### 数据影响与剩余边界

本轮移动的是源码、合成测试与迁移文件，不移动或升级真实业务库，不读取、修改或提交本机 `.env`、聊天、凭据及私人备份，不更改系统权限或当前 App。安装脚本只验证语法与路径，未执行机器安装或业务库迁移。新 UI、桌面宿主、Windows 微信适配与真实微信集成仍未实现或验收。
