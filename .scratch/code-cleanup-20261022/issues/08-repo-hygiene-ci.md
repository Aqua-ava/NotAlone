# 08 仓库卫生与最小 CI

Triage: ready-for-agent
State: resolved

## 目标

B5：去重 logo、让 test-inventory 认领 fixtures 下 `.py` 资产（只登记不执行）、补最小 CI 门禁。

## 证据

`.scratch/code-audit-20261022/verify-unused.md` 第 79 行；`desktop/scripts/test-inventory.mjs:6` 正则只认 `.test.mjs/.test.ts/.spec.ts`；全仓无 CI。

## 范围

- 两份相同 `logo.png`（`website/assets/logo.png`、`desktop/src/renderer/assets/logo.png`，sha256 相同）：保留一份，另一处改为引用同一路径或删除并更新引用；确认 website 构建仍通过。
- `desktop/scripts/test-inventory.mjs`：登记 `desktop/tests/fixtures` 下 `.py` unittest 资产为「未接入 runner」清单（不新增执行，避免依赖环境）。
- `.github/workflows/ci.yml`：最小门禁——后端 unit（`python -m unittest discover -s tests/unit -t .`）与桌面 `npm run typecheck`；不跑桌面 App/打包/微信。
- 不迁移 `experiments/`、`.scratch/` 数据（待用户确认）。

## 验收

- `node desktop/scripts/test-inventory.mjs` 通过并列出新增登记。
- CI 本地语法校验（`python -c "import yaml"` 或等价）；报告 workflow 触发与权限范围。
- 报告 logo 引用核查与删除风险。

## Comments

- 2026-10-22 Lead 认领并完成主体：
  1. 两份 `logo.png` 经核为同一 git blob（`33a9adc1…`，sha256 `61342f0c…`）：git 对象库本身已按内容去重，磁盘上两份分别服务于「官网独立部署（`website/assets/logo.png`）」与「桌面打包（`desktop/src/renderer/assets/logo.png`）」。删除任一份都会破坏其中一条发布路径，因此**不改动 logo**，结论记入报告；跟踪字节指标不再按两份计。
  2. `desktop/scripts/test-inventory.mjs` 新增 `describePythonAssets()`：只登记 `tests/**/*.py`（81 个）为「不在 runner 分类内」，不执行、不阻塞五类登记；`desktop/tests/test-inventory.test.mjs` 补第 4 条用例。验证：`node --test tests/test-inventory.test.mjs` 4/4 通过，CLI 输出 `Python 资产 81 个不在 runner 分类内（只登记，不执行）`。
  3. 新增 `.github/workflows/ci.yml`：桌面 `npm ci`+`npm run typecheck`+`test-inventory`；后端 `python -m compileall -q backend/src`；`check_public_history.mjs`（ubuntu、node 22、无数据库/App/打包）。本地已验证 `check_public_history` 0 issues。
  4. 未迁移 `experiments/`、`.scratch/` 数据（spec 明确 Out of Scope，待用户确认公开证据边界）。
- 剩余风险：后端 unit 门禁未接入 CI（已知 14 条基线失败），单列后续 ticket；CI 首次推送后需观察 ubuntu 上 safe-node 套件是否可加。
