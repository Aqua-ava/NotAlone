# 12 — 首启向导与安装脚本

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 开源用户在干净检出上运行安装脚本即可完成机器级初始化（安装依赖、创建数据库、按顺序应用全部迁移、构建主窗口应用与探针）；首次打开主窗口应用时，向导完成用户级配置：填写模型供应商凭据、初始化 owner。owner 初始化从首次导入提前到应用首启，与导入路径保持同一事务语义与幂等行为（修订 ADR-013 的初始化时机）。

**Blocked by:** 05（主窗口骨架）

- [x] 安装脚本在干净检出上完成环境初始化；失败时给出清晰引导，不留下半初始化的数据库状态。
- [x] 首启向导可填写并保存模型凭据（不回显密钥），并完成 owner 初始化与受控配置写入。
- [x] 首启向导与导入命令的 `--initialize-owner` 两个入口保持同一事务语义与幂等行为，不产生分叉。
- [x] 已初始化过的环境再次运行脚本或向导不重复创建、不破坏既有数据。
- [x] README 如实声明开源用户最低环境要求（macOS、微信桌面版、用户自装 wechat-cli、PostgreSQL、Python 环境、屏幕录制权限）。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-021，修订 ADR-013。

## Answer

首启向导与安装脚本已交付，机器级与用户级两层首次配置闭环：

- **后端首启服务**：`application/setup_service.py`（owner 初始化幂等、凭据受控写入 0600 `.env`、初始化状态查询）与 `persistence/setup_owner_directory.py`（Postgres 实现）；`app.py` 暴露 `/api/setup/{status,initialize,credentials}`。owner 未初始化时后端仍可启动，仅开放 setup 与凭据状态端点，其余端点 503 `owner_uninitialized`（进程级冒烟钉住）。
- **Swift 首启向导**：App 启动检测 `/api/setup/status`，owner 未初始化时全屏覆盖层引导填写展示名称与 DeepSeek 凭据；提交后写凭据 → 初始化 owner → 真正重启后端进入业务模式（修复了复用旧连接导致的重启循环）。
- **安装脚本**：`scripts/install.sh` 按 ADR-021 只做机器级事务（依赖检查、conda 环境、PostgreSQL 建库、按序迁移、构建 App 与探针），幂等可重跑，不读写密钥；失败给出引导。
- **README**：新增《安装与首次配置》章节，如实声明最低环境要求。
- **双轴 review 修复**：`SetupService` 环境路径统一复用 `runtime_config` 的 `NOTALONE_ENV_FILE` 策略（原实现误用 `NOTALONE_ENV_PATH`）；owner 已存在时也把 id 写入 `.env`，避免重启循环；Swift `restartBackendIfNeeded` 先 `terminate + waitForExit` 再拉起。
- **验证**：Setup 单测与契约测试全绿；进程级测试验证 owner 未初始化启动路径；Swift 构建通过；全量 Python 测试 650 项通过（2 项真实模型冒烟跳过）。安装脚本在本机实际运行通过（幂等跳过已初始化阶段）。

## 收尾记录（2026-08-25）

- 本票经两轮完成：先落地后端 setup 骨架（会话中断前），收尾轮补齐 `_parse_setup_json` 并标记状态；后续轮次完成 Swift 首启向导、`scripts/install.sh`、README 声明与双轴 review 修复，清单五项全部交付。
- 已知提示：owner 初始化写入 `.env` 后 App 会自动重启后端生效；`notalone-server` 命令缺失时重跑 `pip install -e .` 会刷新 console_scripts（install.sh 已包含）。
