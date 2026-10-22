# 清理与收敛（2026-10-22）

来源：用户批准 `.scratch/code-audit-20261022/report.md` 的推荐方案（「按推荐」）。证据见同目录 `00-metrics.md`、`verify-unused.md`、`verify-structure-defense.md`。

## 用户问题

代码库被怀疑有大量不必要代码、逻辑混乱与过度防御。审计结论：真死码仅 25 行；大头是评测/实验混入生产包（约 1.74 万行）、未接线功能（桌面 932 行、后端 360 行）、少数巨型结构与吞错点。需要按批准方案收敛。

## 方案（已批准）

- **A1 评测/实验解耦**：先把被生产使用的符号（`experiments.problem_budget`、`experiments.reply_comparison`）提升到生产模块，评测包标 `dev-only`；暂不迁出 `backend/src`。
- **A2 未接线功能**：接回 `OwnerLayeredMemoryPanel`（本人主题资料自管理入口）；删除 `foreground/calibration*` 集群（533 行，无产品入口、构建入口）。
- **A3 结构**：`app.py` 路由表化（行为不变，先补路由黄金测试）；`ReplySession` 拆分记入 backlog，不在本轮。
- **A4 仓库数据**：`experiments/`+`.scratch/` 出仓或 LFS **暂缓**，需用户确认公开可复现证据边界；本轮只做 logo 去重、runner 认领与 CI。
- **B1-B5**：删 25 行零风险死码；handler 级 500 记录 + 桌面静默 catch 修复；`skill_files` 清理路径缺陷；低风险（生产 0 import）清理；仓库卫生与最小 CI。

## Implementation Decisions

- 只读审计报告作证据来源；不改产品硬边界、ADR 决策（ADR-032/085/094/096/097 相关防御保留）。
- 每张 ticket 一个本地提交，中文标题，正文 `1、2、3、4` 列改动/边界/真实验证。
- 并行两路：后端（tickets 01/03/04/07）、桌面（02/05/06），文件范围互斥；Lead 做 08/09 并统一提交。
- 不执行 push、不打包、不改发布门禁、不迁移业务数据。
- 测试夹具只用合成/匿名化数据；不提交私人资料与凭据。

## Testing Decisions

- 后端：`PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest ...`，单用例 → 相关目录 → 全量；最后全量给时间上限。
- 桌面：`cd desktop && npm run typecheck`，再按需 `npm test`（默认安全集）；UI 接线用已有开发实例（`dev:status` pids=3898，不启动第二份）。
- 提交前跑 `git diff --check`；提交后跑 `node scripts/check_public_history.mjs --ref HEAD --working-tree`。
- 文档/注释、提交正文、报告使用中文。

## Out of Scope

- `experiments/`、`.scratch/` 数据出仓/LFS（待用户确认）。
- `ReplySession` 拆分（backlog）。
- 评测代码迁出 `backend/src`（本轮只解耦）。
- `native/`、`website/`、`benchmark` 冗余。
- push / 打包 / 部署。

## 风险

- A1 移动符号会改变 import 图，需全量单测兜底；若无法安全移动则降级为「标注 dev-only + 记录依赖」。
- A3 路由表化是行为不变重构，风险中等；必须先有路由黄金测试（现有端点的 method/path/状态码快照）。
- 删除未接线组件会连带删除仅测试引用的用例，需确认没有丢真实覆盖。
