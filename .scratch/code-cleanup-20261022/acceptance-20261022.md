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
