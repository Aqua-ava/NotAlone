# 11 — Skill 库管理与设置页

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 用户在管理页导入、启用、停用、回滚、删除回复 Skill，并预览其内容与辅助资源；设置页管理模型凭据、探针路径与同步参数，并可打开探针调试窗口（OCR 文本与裁剪预览）；出站台账统计概览可供核对。

**Blocked by:** 05（主窗口骨架）

- [x] Skill 管理共用既有管理端口：完整校验后原子发布、版本不可变、回滚与隐私清理语义不变；拒绝原因在界面可见。
- [x] Skill 预览只展示版本内容与受控辅助资源，不暴露联系人资料。
- [x] 凭据配置写入受控配置，界面与错误信息均不回显密钥。
- [x] 台账概览只含元数据（时间、供应商、模型、联系人范围、用量、结果状态），不含正文；按 owner 隔离。
- [x] 探针调试窗口经设置页打开；屏幕录制权限模型与既有探针一致。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-010、ADR-019、ADR-020。
- 凭据的写入（用户级配置）由首启向导承担（spec 决策 4 与 User Story 4）；设置页只展示配置状态与引导，不回显密钥。

## Answer

- 后端新增 Skill 管理端点：`GET /api/skills`（owner 级列表：名称/描述/状态/当前版本号/启用状态，不含资源内容）、`POST /api/skills/import`（复用 PostgresSkillLibrary 完整校验+原子发布，拒绝 409 `skill_import_rejected` + 稳定 reason）、`POST /api/skills/{id}/enable|disable|delete|rollback`（生命周期语义不变）、`GET /api/skills/{id}/preview`（export_package 投影：文档/资源路径/SHA-256，不暴露联系人资料）、`GET /api/ledger/summary`（台账元数据概览：调用数、供应商/结果分布、token 用量、最近 10 条；无正文，按 owner 隔离）。
- 新增 `SkillLibraryManagementPort.list_owner_skills` 与 `PostgresSkillLibrary` 实现（含 owner 隔离集成测试）；`application/skill_service.py` 薄壳（列表/导入/生命周期/预览 + `LedgerService` 概览）。
- Swift 右栏新增「Skill 库」页：包路径选择与导入、列表（名称/描述/版本/状态 + 启用/停用/删除）、台账概览；新增「设置」页：模型凭据状态展示（不回显）、探针调试窗口打开（独立探针应用子进程，屏幕录制权限模型与既有探针一致）、同步参数说明。
- 验证：Python 全量 627 项通过（新增 Skill 列表集成测试 2 项、API 契约 11 项）；`swift build` 与探针 `swift test` 21 项通过；真实 HTTP 冒烟：列表/台账空数据、import 不存在路径 409 稳定码通过。
- 双轴 code-review（Standards + Spec）修复：生命周期端点域异常映射干净 404/409/500（不再静默无响应）；导入拒绝 reason 区分 `name_conflict`（显式 update）与 `package_invalid`；台账 recent 补 `contact_id`（元数据完整）；Skill 预览改为读版本内容投影（不落盘、不暴露服务器路径）；Swift skillRow 加「预览」sheet（文档 + 资源清单）并移除未接线的死 `rollbackSkill` 客户端方法；设置页凭据状态经 `GET /api/settings/credentials` 动态展示（只回显已配置布尔，绝不回显密钥）；`ledger` 依赖注入类型由 `object` 收紧为 `LedgerQuery` 协议；探针调试窗口改为相对仓库定位（可移植）；ledger 路由拆出独立 `_handle_ledger`（按职责分离）。
- 数据影响：测试使用合成 UUID/`_test` 库；无迁移改动。
- 剩余风险：回滚 UI 未接线（后端 rollback 端点与契约齐备，需版本列表 UI 支持，记为后续）；凭据写入界面由首启向导（Issue 12）承担；探针调试窗口依赖探针包已构建。
