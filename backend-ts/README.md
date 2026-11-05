# TypeScript 本机后台

这里保存 NotAlone 的本机业务后台：联系人与授权、历史同步、记忆处理和检索、候选回复，以及后台任务与删除。文件导入等已采纳但未开放的入口，以宿主报告的实际能力为准。

后台使用 TypeScript，由官方 DSH `0.2.1-rc.2` profile 启动，薄插件装配普通业务模块；各项业务有唯一写入责任。正常路径不运行 Python 或 Conda。DSH 固定源码提交为 `687f282e8625c6b8d11ff58211a90524be2e4317`；依赖声明见 `package.json`，安装锁见根目录 `pnpm-lock.yaml`。

## 目录导航

| 位置 | 内容 |
| --- | --- |
| [`src/`](src/README.md) | 正式业务源码，按联系人、导入、记忆、检索、回复、同步等职责分组。 |
| [`src/storage/sqlite/`](src/storage/sqlite/README.md) | 当前 SQLite 存储、迁移注册与具名事务动作。 |
| `profile/` | DSH 插件装配与运行配置。 |
| `test/` | 当前测试、合成夹具及历史测试登记。 |
| [`diagnostic-problem-budget.md`](diagnostic-problem-budget.md) | 问题诊断期间的模型调用累计预算。 |
| `node_modules/` | 包管理器安装的第三方依赖。 |

## 开发与验证

使用 Node.js ≥24。在仓库根目录执行 `pnpm install --frozen-lockfile` 安装锁定依赖。

日常运行先在仓库根目录执行 `pnpm run dev:status`，复用已有开发实例；没有当前项目实例时才执行 `pnpm run dev`。沿用已确认的配置、SQLite 实例、身份和资料位置；启动失败不清空或新建替代业务资料。日常开发不打包，操作和最小验证规则见[工程工作流](../docs/agents/engineering.md)。

按改动范围在本目录选择最小检查；`pnpm test` 是当前后台完整测试入口，不必为纯文档改动运行：

```bash
pnpm run typecheck
pnpm test
```

正式启动使用 `profile/sqlite.patch.yml` 与 `src/sqlite-host-plugin.ts`。SQLite 宿主与 profile 测试使用隔离的合成资料和模型替身，不读取用户的真实密钥或环境配置。

协议、预算与取消用例中的测试插件仍显式覆盖输出额度（如 `256 tokens`）、上下文容量、调用次数、超时和合成提示词，以触发边界。这些用例验证程序行为；真实回复效果须从正常业务入口、使用用户实际模型配置另行验收，不能由模拟服务结果推断。

默认入口运行当前 Node 业务与生命周期测试。旧 Python 对照测试仅在固定 Git 树中显式运行，使用方式见[历史测试说明](test/HISTORICAL.md)；历史结果不能计作当前版本通过。

当前数据库的连接、迁移和失败处理见 [SQLite 存储合同](src/storage/sqlite/README.md)。正常启动不会自动下载向量模型；显式准备使用仓库根目录的 `node scripts/prepare_memory_embedding.mjs`，`--offline` 验证已有固定缓存。

## 自动后台处理开关

受控环境文件可设置 `NOTALONE_BACKGROUND_PROCESSING=manual`；默认值为 `automatic`。配置在宿主启动时固定，修改后须正常退出并通过开发入口重启；进程环境优先于环境文件，非法值拒绝启动。认证 `/api/runtime/status` 的 `background_processing` 返回本实例实际模式。

日常 App 保持默认自动处理。诊断需要 `manual` 时使用隔离实例和独立环境文件，不把该覆盖留在日常 `.env`；同步总开关仍然开启并不代表手动模式会自动派发任务。恢复日常环境后核对实际运行模式及消息入库，不能仅凭总开关确认同步正常。

`manual` 模式默认不启动或唤醒全联系人首次历史、增量、图片、引用或记忆的自动队列，也不自动恢复旧记忆轮次和后续主题／概览工作。联系人读取授权、同步总开关与旧任务事实保持；正常具名单联系人历史同步、来源认证、记忆启动／继续和媒体请求仍可手动使用。此开关控制自动派发，不替代具体操作的联系人范围确认。恢复 `automatic` 后由原有持久队列重新检查资格，暂停和未知回执保护继续有效。

图片可用 `NOTALONE_IMAGE_PROCESSING=automatic|manual` 单独选择自动派发，未设置时继承上述模式。例如后台 `manual` 配合图片 `automatic`，只自动补查有效授权联系人已有及新增的图片，不启动其他手动后台任务。缺副本、仅缩略图（不保存缩略图）及失败会持久退避重试，已保存图片不重复读取，清除项不恢复；同步总开关和来源认证仍必须有效。认证状态接口的 `image_processing` 与 `image_sync` 返回实际模式和不含联系人内容的运行汇总。此配置同样在宿主重启后生效。

## 数据与验证边界

- 联系人、来源和自动采纳边界见[领域数据](../architecture/current/domain-data.md)；每次回复绑定已确认联系人，最终消息由用户亲自发送。
- 回复运行副本、上下文和预算见[回复生成](../architecture/current/reply-generation.md)；日志与模型原稿不自动成为长期关系事实。
- SQLite 写入和迁移见[存储接口](src/storage/sqlite/README.md)，来源闭包与清理完成条件见[隐私与删除](../architecture/current/privacy-deletion.md)。
- 同步范围、停读和迟到结果处理见[微信同步](../architecture/current/wechat-sync.md)；自动处理的运行开关见上节。
- 清理旧模块和依赖不移动、升级或删除用户业务资料。冻结评测中的旧 `backend/...` 路径保留为历史来源标识。


阶段实现和旧验收记录已移至[开发历史](../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
