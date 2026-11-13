# 自动加载回复 Skill：验证记录

日期：2026-10-19。仅使用合成资料；真实开发 App 只验收界面，不调用真实联系人模型、不发送消息。

## 结果

- 相关 Python unit 六模块：56 项通过；新增公开 HTTP：8 项通过；实际随机隔离 PG 组件：18 项通过、0 skip，库已删除。
- 扩大 HTTP 探索回归：55 项首轮 54 通过、1 次既有多来源生成客户端超时；失败单例隔离重跑通过，未放宽超时。
- Node 相关回归最终 21 项通过；TypeScript 类型检查通过。
- 页面：回应/主动 × 选中/无匹配四场通过；回应/主动 × 停用/删除四场通过。两组清理均确认，自有进程退出、租约 absent。
- 遗留状态回归先见证新探索错误携带 disabled，再修复为 auto/null 并通过；检查原操作重试及候选 input.scene=null。
- Computer Use 实际操作既有 npm run dev App：打开输入小窗，查看主动联系策略区域，确认无手选、无场景输入、只读自动匹配说明及布局。
- npm test 完整安全调度套件：183/184；探针准备测试计数 19≠18 失败。该探针、测试及并行前台改动不属于本任务，未为此修改。
- Standards 与 Spec 双轴审查最终均 0 未解决发现；Spec 发现的旧隐藏状态继承已修复并复审。

## 实际命令

在 backend/：使用工程工作流指定的 NotAlone Conda Python 环境，以下省略本机 PATH 前缀。

- python -m unittest tests.unit.reply.test_exploration_skill tests.unit.reply.test_exploration_runtime tests.unit.reply.test_exploration_skill_selection_runtime tests.unit.reply.test_exploration_service tests.unit.reply.test_exploration_input_budget tests.unit.reply.test_exploration_context
- python -m unittest tests.integration.server.test_automatic_exploration_skill
- 用 CoreBusinessFlowFixture 临时建库/迁移，运行 tests.integration.persistence.test_reply_exploration.ReplyExplorationPersistenceTest，并在 finally 清理。
- perl -e 'alarm 300; exec @ARGV' -- python -m unittest discover -s tests/integration/server -p '*exploration*.py' -t .
- python -m unittest tests.integration.server.test_persistent_reply_exploration.PersistentExplorationHttpTest.test_multi_source_memory_outside_generation_window_has_one_complete_dependency -v

在 desktop/：

- npm run typecheck
- node --test tests/reply-strategy-display.test.mjs tests/skill-learning/view.test.mjs tests/reply-used-skill.test.mjs tests/assistant-input-budget-notice.test.mjs
- 按工程工作流设置 NotAlone Conda 环境后 npm run test:pages -- --case reply-strategy-skills --timeout-seconds 180
- 同环境 npm run test:pages -- --case reply-strategy-skill-invalidation --timeout-seconds 180
- perl -e 'alarm 600; exec @ARGV' -- npm test

## 数据及限制

无需 schema 迁移。新增探索记录用服务端 JSON 标志固定版本或明确 None；删除沿原记录路径。选择调用只增加当前冻结输入与目录名称描述，不发送全部 Skill 正文、不扩大联系人或精确场景权限。

页面启动曾被前一天已过期且进程不存在的租约阻挡，保留原记录后回收；测试清理器的过期迁移白名单已改为核对正式连续迁移及完整账本。未打包、未 push。真实供应商语义效果与微信渠道未据此认证。
