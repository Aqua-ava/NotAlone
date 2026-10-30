# PostgreSQL 旧模块与依赖退役（2026-10-30）

用户范围：继续清理旧模块、测试中的 `pg` 引用并移除依赖；保留当前 SQLite 行为、资料边界和历史追溯。对照基线为 `a838de83c4825ae0c219cf6945ddc6cda4382273`。

## 变更与边界

- 当前源码、测试、开发脚本不再导入 `pg`；workspace 清单和锁文件移除 `pg`、`@types/pg` 及 13 个不再被引用的间接依赖，没有升级其他库。
- 删除 195 个旧 PostgreSQL 宿主、存储、schema 准备及专属服务源文件；保留 SQLite 实际使用的 JSON 指纹、时间、模型台账校验和裁决 DTO，并拆为 4 个不依赖数据库驱动的模块。提取策略的源码指纹入口改为实际 SQLite 服务，继续核验完整依赖闭包。
- 源码变更会产生新的策略指纹；旧任务仍按既有版本资格校验处理，不伪造旧指纹、不自动重跑任务。没有迁移或写入真实业务资料。
- 删除旧安装器和 PostgreSQL 打包链；最低 macOS 版本改用独立配置。发布入口仍由原门禁拒绝，没有构建或运行发布包。
- 151 个旧测试与夹具登记在 [独立退役清单](../../backend-ts/test/retired-postgres-inventory.json)，每条均能在固定基线取回；当前后端保留 136 个根测试文件。原 `23a76733` Python 历史清单保持独立；两类历史结果均不计作当前版本通过。
- 保留历史 SQL、明确标记的历史文档，以及切换控制面对旧库的识别、归属与停写保护。未连接或删除真实 PostgreSQL 数据；未读取或修改微信正文、联系人、模型密钥及用户 Skill。

## 验证口径

使用 Node 24.21.0；仅断开本任务工作树的 `pg` / `@types/pg` 两个安装链接，共享依赖缓存和其他工作树保持不变。当前 workspace 无法解析这两个包。

依赖更新通过 pnpm 11.25.0 的离线 lockfile-only 操作生成并通过冻结锁验证；保留原 YAML 格式后逐项比对解析结果，差异仅为上述依赖删除。新增守卫检查所有当前源码、测试和脚本的驱动导入及三份 workspace 清单、锁文件。

桌面检查复用既有热更新实例，实际点击重新检查存储后，界面继续显示 SQLite 3.53.4、结构版本 18 已就绪。该隔离实例原有的本机服务未连接状态保持；这不是模型、真实历史导入或发布包验收。

已运行的相关检查：

- `backend-ts/` 与 `desktop/` 的 `tsc --noEmit` 均通过。
- 来源策略、驱动退役及台账合同守卫 13/13；SQLite 底层事务与重开回归 10/10。
- 正式历史宿主、策略身份及记忆 profile 的定向检查通过；正向记忆用例按当前 08→09 流程完成，未知调用仍不重发。后端最终全量 891 项，861 通过、30 个既有失败、0 跳过；失败集合与固定基线逐项一致。
- 桌面清单、SQLite 启动及发布拒绝边界 24/24；启动、退出、轮询与旧代码清理回归 19/19。
- 桌面 `safe-node` 清单全部执行：常规组 990 项，986 通过、3 失败、1 项沿用既有跳过；两个已知停滞文件独立加 3 秒用例上限，111 项中 109 通过、2 取消。合计 1101 项，1095 通过、3 个既有失败、2 个既有停滞、1 项既有跳过。没有因 PG 退役新增跳过项。

后端全量命令：`cd backend-ts && node test/run-current.mjs --test-timeout=60000`，外层限定 600 秒；类型检查为两端分别运行 `node node_modules/typescript/bin/tsc --noEmit`。桌面执行与 `scripts/test-safe.mjs` 相同的清单及 esbuild 参数，分开上述两个停滞文件；它们单独运行 `node --test --test-timeout=3000 tests/assistant-candidate-version-ports.test.mjs tests/historical-reply-basis.test.mjs`。所有模型请求均由隔离合成供应商处理，没有真实模型调用。

## 已有验证限制

为区分清理回归与既有问题，在仓库外恢复固定基线及其原依赖。以下桌面问题在该基线复现，未通过删除、跳过或放宽断言处理：

- `development.test.mjs` 的依赖文件访问断言返回 403：当前依赖目录链接到其他工作树时，Vite 的目录授权范围不包含该物理路径。
- `layered-memory/owner-render.test.mjs` 的服务端渲染缺少 `window`。
- `helpers/probe.test.mjs` 的默认探针路径断言得到空路径；隔离基线重跑同样失败，探针编译步骤本身成功。本轮没有改变探针或恢复旧打包链来绕过该断言。
- `assistant-candidate-version-ports.test.mjs` 与 `historical-reply-basis.test.mjs` 各有一个未完成用例；基线有界运行共 111 项，109 通过、2 取消。原默认无时限运行会停留在这两个 worker。

后端保留的 `sqlite-adjudication-deletion`、`sqlite-adjudication-migration`、`sqlite-clear-http`、`sqlite-history-source-holder`、`sqlite-memory-documents-migration`、`sqlite-wechat-history-channel` 六文件也在该基线单独执行：48 项中 18 通过、30 失败，错误包括 `storage_invalid`、`deletion_input_invalid` 和旧能力断言。清理后对应失败逐项匹配；这些用例继续保留，没有归档或跳过来制造全绿。

这些结果不属于 PostgreSQL 驱动残留，不宣称默认全量测试全绿。
