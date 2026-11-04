# 文档、ADR 与整项验收

Triage: ready-for-agent
State: resolved
Blocked by: 01, 02, 03

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

删除现行文档中的排除功能描述，新增 ADR-165 说明替代关系，并完成全链路验证。

## 范围

- `architecture/current/reply-generation.md`、`core-flows.md` 和 README 的现行表述。
- 新增 ADR-165，并在 ADR-079 标注部分替代。
- 全仓 `excludedMessageIds`／`excluded_message_ids` 清理与兼容拒绝检查。
- 最小相关测试、类型检查、实际开发 App 交互验收。
- 不修改历史记录正文，不删除历史资料。

## 测试 Seam

公开边界：文档引用、当前 SQLite 生成、旧回复合同和桌面可见交互。

## 验收

- 当前文档不再把逐条排除写成可用能力。
- 全仓只保留必要的旧字段拒绝与历史说明。
- 后端、桌面测试和实际 App 验收覆盖新默认行为。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。

## Answer

- 文档：新增 ADR-165，记录逐条消息排除退役、关系背景总开关与最近最多 50 条自动上下文、工作区 `version: 2`、旧字段拒绝、旧请求不可静默重试及不迁移历史数据；在 ADR-079 顶部标注被 ADR-165 局部替代的范围。同步更新现行回复生成、核心流程、README、ADR 索引和 SQLite 候选模块说明。
- 自动化：退役字段全仓扫描覆盖 1,596 个文件，仅保留旧字段拒绝实现、兼容回归、ADR-165 历史说明；现行文档与 README 不再描述逐条排除。当前 SQLite 工作区合同纯函数回归 3/3 通过，桌面 bridge 合同 7/7 通过，旧桌面回复链路相关回归 29/29 通过；候选面板 esbuild 浏览器 bundle 成功。新增 ADR 链接 4/4 有效，`git diff --check` 通过。
- 类型检查：使用外部只读依赖目录对当前 SQLite 共享合同和 `SqliteReplyCandidatesPanel` 做 TypeScript `--noEmit` 检查，通过；未写入 `node_modules`。全仓桌面 typecheck 因隔离路径下 `vite/client` 类型装载差异报既有 `ImportMeta.hot`，未作为本次绿例。
- 未完成：按用户要求没有启动或重启 App，也没有执行桌面交互验收；`sqlite-reply-candidates.test.mjs` 已编译但 Playwright 在当前沙箱启动 Chrome 时以 `SIGABRT` 退出。带 SQLite Worker／环回 HTTP 的后端全链路回归在本沙箱因 `worker_failed`／`listen EPERM` 无法复跑，复用 ticket 01 中后端相关 42 项通过的记录；后端实现此后未变化。
- 风险：当前证明来自公开 IPC 合同、纯工作区合同、SSR／bridge 回归和文档扫描；复选框消失、只读列表、刷新保留编辑、关系背景开关及最近 50 条实际进入候选当时仍需真实开发 App 与微信对话按桌面验收规则确认；该缺口后由实际开发 App 验收补齐，State 由 `claimed` 改为 `resolved`。

- 2026-11-04 最终收口：文档、ADR-165 与旧字段扫描保持通过；实际开发 App 已覆盖只读最近聊天、关系背景开关、无排除字段和旧载荷拒绝的可操作路径。最终相关桌面回归 69/69、typecheck 通过，未触碰两个既有用户修改。
