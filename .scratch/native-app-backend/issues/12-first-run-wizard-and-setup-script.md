# 12 — 首启向导与安装脚本

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 开源用户在干净检出上运行安装脚本即可完成机器级初始化（安装依赖、创建数据库、按顺序应用全部迁移、构建主窗口应用与探针）；首次打开主窗口应用时，向导完成用户级配置：填写模型供应商凭据、初始化 owner。owner 初始化从首次导入提前到应用首启，与导入路径保持同一事务语义与幂等行为（修订 ADR-013 的初始化时机）。

**Blocked by:** 05（主窗口骨架）

- [ ] 安装脚本在干净检出上完成环境初始化；失败时给出清晰引导，不留下半初始化的数据库状态。
- [ ] 首启向导可填写并保存模型凭据（不回显密钥），并完成 owner 初始化与受控配置写入。
- [ ] 首启向导与导入命令的 `--initialize-owner` 两个入口保持同一事务语义与幂等行为，不产生分叉。
- [ ] 已初始化过的环境再次运行脚本或向导不重复创建、不破坏既有数据。
- [ ] README 如实声明开源用户最低环境要求（macOS、微信桌面版、用户自装 wechat-cli、PostgreSQL、Python 环境、屏幕录制权限）。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-021，修订 ADR-013。

## 收尾记录（2026-08-25）

- 本票仅后端首启向导骨架落地，未整体完成；此轮为会话中断后的收尾，剩余功能按用户决定暂缓不做。
- 已完成并可工作（后端）：`application/setup_service.py`（owner 初始化幂等、凭据受控写入 0600 .env、初始化状态查询）与 `tests/unit/application/test_setup_service.py`、`tests/integration/server/test_setup_api.py`；`app.py` 接线 `/api/setup/{status,initialize,credentials}`，收尾时补齐缺失的 `_parse_setup_json`，契约测试与单测全绿。
- 未完成（暂缓）：Swift 首启向导 UI（检测未初始化 → 全屏向导）、`scripts/install.sh` 安装脚本、README 最低环境要求声明。清单第一、二、四、五项均未交付。
- 首启向导与导入 `--initialize-owner` 的同一事务语义/幂等（清单第三项）在后端 SetupService 已体现，但未与 Swift/CLI 入口核对，仍视为未完成。
