# 自动记忆维护验证记录

日期：2026-10-18。全部模型响应使用合成夹具，未发送私人聊天至模型，未打包或推送。

## 已验证

- 桌面 `npm test`：类型检查与 161 项安全测试通过。
- `node --test tests/layered-memory/automatic-maintenance.test.mjs`：2 项通过，联系人／本人自动轮询和文案正常；不把逐条核验伪装成全局质量达标。
- 默认 L1 流程及来源、采纳、合并等相关单测：104 项通过。覆盖自动新增与更新、不支持内容拒绝、人工保护及全部来源核验。
- 默认整理工厂和 SDK：9 项通过；隔离数据库默认联系人／本人自动整理及迁移：4 项通过；维护和删除：8 项通过；显式评测配置和回复读取：3 项通过。
- 旧升级入口 404、Worker 不领取退役步骤；遗留升级来源／联系人删除回归 2 项通过。
- 分层桌面测试首次运行 99 项，95 项通过，4 项因未配置外部证据目录失败。补齐环境后 HTTP 夹具 2 项通过；纠错 2 项揭示了真实回执和重建问题，已修复并单独复验，最终结果见下。

## 检查边界

- 使用正在运行的 `npm run dev`，通过 Computer Use 实际查看管理导航和记忆页，确认没有旧资料升级入口。
- 首次实际后端提示“数据库迁移账本或基线发生漂移”；另一会话提交 `137804a0` 修复后，已再次通过 Computer Use 确认管理后台和记忆页显示已连接、旧入口消失。本次未用真实聊天触发模型，因此不宣称真实模型质量或真实聊天全链路验收通过。
- 大范围记忆提取单测 969 项中 964 通过、4 失败、1 错误；已用改动前基线复现两个旧夹具问题，另有 3 个 reference16 子进程启动问题。完整后端 `perl -e 'alarm 600; exec @ARGV' -- python -m unittest discover -s backend/tests -t backend` 在 600 秒上限退出（142），存在失败，未取得完整汇总；单例复现发现 `NOTALONE_TEST_DATABASE_URL` 未配置。结果不作为全量通过证明。
- 并行 Standards／Spec 复审发现并修复：合法本人记忆的跨联系人来源批次误拒绝，以及旧历史批次反复把新整理世代标记过期。跨联系人例外仅限已注册导航依赖，仍检查同一 owner 和有效来源。

## 最终组合回归

在 `backend/` 下运行：

```bash
python -m unittest tests.integration.server.test_memory_skill_evolution tests.integration.server.test_default_memory_maintenance tests.integration.persistence.test_retired_upgrade_cleanup tests.integration.persistence.test_assistant_processing_dependencies tests.unit.server.test_memory_upgrade_removed tests.unit.tasks.test_retired_memory_upgrade -v
```

20 项中 19 项通过：9 项记忆／回复／Skill 完整组合全部通过、来源批次反控 3 项通过、遗留升级清理 2 项通过。新增纠错重建用例在运行期间加入，首次失败，按单例修复验证，最终结果补记于下。

新增纠错重建单例最终通过（3.663 秒）：修正后无需手动刷新即生成新的完整 L2/L3，旧批次／画像留作审计，来源删除清理新旧全部批次／画像。生产修复包括：只让当前发布代影响当前状态；失效旧集合退出当前指针，保留历史空代后继续自动重建，不再尝试重发无效旧集合。夹具为新记忆使用对应主题身份，不复用已退休主题 ID。

最终 `npm run typecheck` 与 `git diff --check` 通过。两轮 Standards／Spec 复审无剩余阻断；本次没有声称全量测试或真实模型质量通过。

最终纠错 HTTP 预检 `node --test tests/layered-memory/correction-native-preflight.test.mjs` 在外部证据目录与 NotAlone Python 环境下 2/2 通过（144.6 秒）；覆盖联系人／本人八步纠错和修正后实际重建。默认维护 4 项和迁移 1 项全部通过。

最后在隔离测试库补跑原有手动刷新、失败暂停及预算 2 项，全部通过。测试库均由夹具 finally 清理；两个桌面 HTTP 夹具确认 `database_remaining=false`。复用现有开发 App，未创建打包产物；验收记录和日志保留在仓库外。

提交后公开历史检查 `node scripts/check_public_history.mjs --ref main --working-tree` 报告 23 处既有本机路径记录，位于 desktop/README.md、docs/agents/engineering.md 及其历史版本；当前文件命中逐条与父提交核对均已存在。检查未通过，不修改既有历史，未推送。
