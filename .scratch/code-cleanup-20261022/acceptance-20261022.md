# 清理轮验收记录（2026-10-22）

> 范围：`.scratch/code-cleanup-20261022/issues/01-08`。只读/开发实例验收，未推送、未打包。

## 自动验证

- 后端全量单测（`cd backend && python -m unittest discover -s tests/unit -t .`）：2498 例，13 failures + 1 error，与改动前基线逐条一致（pgvector 需仓库根 `experiments` 包 + 13 条 memory_extraction 既有失败）；`wechat_cli` 时序用例全量并发下偶发、单跑通过。
- 桌面：`npm run typecheck` 通过；`npm test` 973 项 972 通过 1 跳过 0 失败；`node scripts/test-inventory.mjs` 通过（safe-node 123）；`git diff --check` 干净。
- 提交前 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 0 issues。
- 未运行：集成测试（需真 PostgreSQL：media lifecycle、ADR-094 联系人级联删除、Postgres skill 集成）；`isolated-http-pg`/`native`/`app` 组；桌面打包。

## 真机验收（开发热更新实例，pid 40730）

- 先 `npm run dev:status` 确认复用现有开发实例（未启动第二份、未打包）。
- 管理后台 → 记忆 → 「我」：页面渲染「我的记忆」「版本历史」「主题资料」入口。
- 展开「版本历史」：渲染本人事实与偏好概览（本人资料集合修订 99、整理时间、空状态/来源说明）。
- 展开「主题资料」：成功挂载本人主题资料面板，渲染真实本人底层记忆（修改/删除入口、来源日期、适用性），证明 ticket 06 的接线在真实 App 生效。
- 本次只读展开，未修改/删除/确认任何记忆，未生成候选，未发送外部消息。
- 截图含真实联系人资料，已删除，不入仓（`.dsh-computer-use/` 已加入 `.gitignore`）。

## 未覆盖

- ticket 02 的错误可见性只由单测/源码契约验证，未在真机构造后端断开/保存失败故障；ticket 06 读取失败路径由 Chromium 接线测试覆盖，未在真机注入故障。
- ticket 09（app.py 路由表化）尚未开始。
- `experiments/`、`.scratch/` 数据出仓/LFS 仍待用户确认。

## 追加（ticket 09 / 10）

- **09 app.py 路由表化**：`BackendApp._handle_authenticated` 197 → 42 行；25 条显式路由（`_ROUTE_TABLE` 23 + `_LIFECYCLE_ROUTE_TABLE` 2）；新增黄金测试 26 用例/32 分派样本。行为差异 0（2,072 个 method+path 组合首命中无差异）；golden 26/26、`tests/unit/server` 133/133、全量 2,527 例 13F+1E 与基线一致。`app.py` 3,972→4,272 行（多为路由表与抽出的处理器方法），类体 2,610 行。
- **10 retrieval 评测懒加载**：`import notalone.retrieval` 不再加载 931 行 evaluation；旧导入名保留；新增 3 条测试，`tests/unit/retrieval` 105/105 通过；子进程验证生产导入不含 `notalone.retrieval.evaluation`。
- **A1 最终验证**：生产导入 `notalone.server.app`/`reply.quality`/`retrieval` 等后 `sys.modules` 不含 `notalone.experiments`；两个评测 CLI 兼容入口 `--help` 正常，旧名仍可 import。
- 累计：自 `08b6df90` 11 个本地提交、92 文件、+2,922/−2,140；未 push、未打包。剩余：A4 数据出仓（待用户确认）、需真 PostgreSQL 的集成测试、ticket 07/09 Comments 中记录的后续项。
