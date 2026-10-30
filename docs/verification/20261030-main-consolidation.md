# 本地分支与工作树归并验收（2026-10-30）

用户要求将全部本地分支及工作树成果合入 `main`。起点为 `f1bf222f`；固定清单包含 12 个本地分支、23 个工作树，共 24 个不同提交。没有执行远端推送、删除原分支或删除原工作树。

## 合并结果

- `b3830bf6` 为最新产品集成树，包含 SQLite 重建、单联系人隔离历史和 PostgreSQL 旧实现退役；保留 `main` 的工作流更新与官网部署移除。
- `870dfcbf` 的 FSEvents 合成原型与 `de4342d2` 的来源验证记录单独合入。任务记录冲突保留两边历史，并明确旧结论不覆盖后续范围收口。
- `157899bf`、`373501dd`、`0bf15b2b`、`9aa51a0a` 为已有实现的旧谱系。独立审计确认存储、联系人绑定、Skill 受管路径、同步删除回调和元数据持有者均由当前树覆盖；合并其谱系时保留当前文件，避免恢复旧能力集与启动配置。旧提交原文仍可通过 Git 读取。
- 其余来源提交均已包含于上述集成链。固定清单的全部 24 个提交均通过祖先检查。
- 产品源码、正式 profile、依赖清单与锁文件相对 `b3830bf6` 逐字不变。本次冲突处理未增加新业务行为。

## 本地分支固定点

| 分支 | 归并前提交 |
| --- | --- |
| `codex/fsevents-continuity-prototype` | `870dfcbf` |
| `codex/ran-history-validation` | `de4342d2` |
| `codex/sqlite-rebuild-integration` | `ef7ca9c8` |
| `codex/state-quarantine-prototype` | `b3830bf6` |
| `dsh/sqlite-rebuild-03` | `34a6f98b` |
| `dsh/sqlite-rebuild-09` | `25e06116` |
| `main` | `f1bf222f` |
| `sqlite-rebuild-04` | `c9658274` |
| `sqlite-rebuild-06` | `a2e6862d` |
| `sqlite-rebuild-10` | `d2a1aee7` |
| `sqlite-rebuild-20` | `aff0366d` |
| `sqlite-rebuild-21` | `4849e12f` |

## 本轮验证

- Node 24.19.0；后台和桌面各执行 `node node_modules/typescript/bin/tsc --noEmit`，均通过。
- 后台：`node --test --test-timeout=30000 test/sqlite-storage.test.mjs test/sqlite-no-postgres-dependency.test.mjs`，12/12 通过。
- 后台：同一命令选取五个 `quarantine-*` 测试文件及 `sqlite-contact-binding`、`sqlite-deletion`、`sqlite-incremental-sync`，72/72 通过。
- 桌面：`node --test --test-timeout=30000 tests/sqlite-development.test.mjs tests/quarantine-controller.test.mjs`，8/8 通过。
- 桌面：`node scripts/test-inventory.mjs` 通过；只核验清单，不等同于全量执行。
- 合成 FSEvents 原型执行 `clang -fsyntax-only` 通过，保留一项既有 API 弃用警告；未在真实资料上运行原型。
- Computer Use 复用既有开发实例，操作“重新检查存储”，完成后显示 SQLite 3.53.4、结构版本 18 已就绪。本机服务仍显示既有未连接状态；不据此宣称完整业务闭环通过。未启动第二个实例，未打包，未更改同步授权。

## 边界与既有缺口

本次没有读取微信正文、调用外部模型、迁移或删除真实业务资料。主仓原有 `.gitignore` 修改及未跟踪文件用归并前后摘要核对；不作为本次提交内容。

既有全量结果与失败集合见 [PostgreSQL 退役验收](20261030-postgresql-retirement.md)：后端 30 个失败，桌面 3 个失败、2 个停滞与 1 个跳过均有原记录。本次产品代码相同，复用该结果，不重复执行全量或将其改记为通过。真实渠道状态认证、跨重启来源续证与正式导入仍按原记录保留边界。

公开检查分开记录历史与当前工作区。开始时主仓完整历史加工作区有 17 项命中，属于既有未跟踪本地记录；所有待合并最大来源的历史单独检查均为 0。最终历史与工作区结果在归并后再次核验，不删除用户文件以清除命中。
