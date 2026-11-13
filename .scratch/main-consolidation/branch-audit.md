# 本地主线收敛审计

固定基线：`main=d174538f`，2026-10-17。来源清单固定 78 个本地分支与 19 个 detached HEAD；核验提交映射、祖先、补丁及相关函数，不以旧 hash 是否为祖先单独判断漏合。本文只记录本地集成，不代表推送、业务迁移或真实质量验收。

## 保留的独立交付

| 来源 | 结论与处理 |
| --- | --- |
| `memory-skill-integration@2f1880ae` | 记忆与 Skill 正式精选集成链；`integration-15@3cc19da7` 与其文件树相同，其余 integration 编号分支为中间交付。 |
| `standalone-app@9ba25235` | 独立 App 交付链，包含手动输入、首启、受管运行时与数据更新，独立集成。 |
| detached `b693236c` | E2 语义、稳定事实提示与完整 140 窗入口；包含 `13db1df3`，并组合 `c840b22f`、`5aff314c` 的产品成果。 |
| detached `d844cb07` | 未来安排、主观评价与来源自然日核验提示；其前两个提交与上一条重复。 |
| detached `2b3f12f3` | 有限运行依据和指定任务链；证明模块与 detached `9d928a1f` 完全相同。 |
| `wechat-media-extraction@c2d5b317` | 独立媒体生命周期部分实现。生产 Reader 仍拒绝未经证明的关联，不能宣称完整媒体支持。 |
| `budget-sync-closeout` | `fa75938d` 的全局 CLI 失败 envelope 不能被当作空闲；`03ac0d21` 的按钮与确认提示需对照当前界面精选；`01f024c5` 主要是连续性测试与记录。 |
| `reply-strategy-completion@3615960d` | 当前控制器遗漏同一冻结命令的多步澄清累计选择；独立移植 Map 合并与 HTTP 回归。 |

## 旧会话与表达尾链

对下列十条尾链的已发布祖先之后，共核验 288 个触及产品源码的提交。重复的消费者和旧原型按当前函数行为归并，确认仍需补入的是 `3615960d`。

| 旧分支 | 已消费或替代的证据 |
| --- | --- |
| `assistant-session-07-18` | 新消息采用在 `6c5955ff`；同命令准备结算在 `378c0e6c` 和 `AssistantGenerationJobs.settleEndedUnknownPreparations`；公开控制器在 `5fc4cda7`。 |
| `assistant-session-07-18-history-20261012` | `504eac9c` 的消息采用、控件与桥接已在正式消息采用和连续修改接口中，不回灌历史装配副本。 |
| `authentic-expression` | 旧 `fidelity/*` 已迁入 `reply/fidelity.py`、`fidelity_evaluation.py`；`generation_contract`、`factual_role` 与来源边界提示均保留。旧独立样本原型由正式生命周期替代。 |
| `authentic-expression-c` | `2858a800` 消费正式样本生命周期；后续来源、实际使用与传递删除继续增强。 |
| `authentic-expression-completion` | `281490dd` 保留当前意愿，`78cf9691` 集成连续修改；旧 Panel 被现行 Controls 替代，`b83f50f7` 已保留码点边界。 |
| `authentic-expression-integration` | `51483bfe`、`5beee94a` 保留候选携入和捕获闭包删除；`d29436bf`、`464dd8f8` 保留可靠生成和预算回执。 |
| `reply-strategy-completion` | 主体由 `78cf9691`、`9c93727b`、`6c5955ff` 消费；仅 `3615960d` 的多步澄清选择累计需要补入。 |
| `round29-a` | `_input_rows/read_input_records(input_version_id=...)`、`require_continued_confirmed_intent`、原确认身份中断恢复均已在主线。 |
| `round29-b` | `1f1512bf` 的新消息采用新增逻辑全部存在；`sameCommand`、唯一准备登记和显式重试保持。 |
| `round29-c` | `39e305b5` 的码点控件、`10bffaa6` 的历史确认意愿与恢复门禁已存在；旧退出接口由现行作业生命周期增强。 |

删除差异按当前 `captured_uses`、`carry_edges`、`select_assistant_input_dependents` 及样本来历失效集合核对；旧 SQL 和较窄的来历类型不回灌。完整讨论由同事务读取、当前输入核验和捕获依赖复验承接，不用旧查询替换现行实现。

## 其他分支与现场

| 来源 | 结论 |
| --- | --- |
| 文档扫尾、类型收紧、未定义名字、测量夹具分支 | `git cherry` 已证明对应补丁在 main，属于尚未收尾的分支引用。 |
| `self-grounded-race` | 在正式记忆集成之上只增加诊断、验收测试；后台等待 helper 已由 `89ae0447` 移植。 |
| memory event／learning／upgrade／preferences 旧交付 | 正式精选链已吸收或增强；升级应用、服务和来源删除共享面已逐路径核对，不能再次整链覆盖。 |
| `memory-semantic-gap` | 研究归档，结论不启用生产语义检索。 |
| `foreground-event-trigger@c79bd588` | 旧后端 SSE 变化源由当前原生 `changeSource`、串行观察和退避实现替代，不恢复旧架构。 |
| detached `096d2ecc` | 冻结规格与任务记录，无独立产品源码。 |
| 旧 author-quote detached 脏区 | 产品源码、迁移和测试已在 `0ae43e50` 发布或在 main 增强；旧 ADR 和任务记录须保留，不能直接覆盖现行文档。 |

## 后续独立切片

takeover 的最终工程实现定位到 `ca80ff00`。原任务记录明确批准结构化五项检查、严格 Beta 协议与一次生成加一次复核；整体质量仍未通过，保持原 `claimed` 与失败记录。

- `6916f1eb`：只沿人工更正冻结窗口恢复概览导航。
- `bf275a35`：只规范化逐字相同消息组的分隔符，其他不一致继续拒绝。
- `f562fea8`：改写本次要求非空时不注入长期偏好，保留修订和删除依赖复验。
- 完整复核：最终 `constraint_review`、`constraint_review_contract`、`rewrite_literal_changes`，以及逐调用台账、取消收尾、来源复验、全拒绝业务反馈与严格路由计量。共享文件逐函数适配，不整体替换 runtime、wiring 或预算模块；默认模型和通用预算保留 main。

helper 分支记录用户两次失败后明确要求“纯粹显示／隐藏”，没有发现后续明确撤回。只精选窗口行为：显式入口仍观察并聚焦；快捷键使用独立展示路径和 `showInactive`；有可见窗口时不自动恢复管理窗。适配当前 hooks，不带冲突旧 ADR。

迁移冲突覆盖 main 的 `059`、记忆精选链的 `059–068`、媒体的 `059`、有限运行依据和独立 App 各自的 `060`。必须采用统一前向迁移计划，不能只消除单个重复文件名。

## 本轮小修验证

CLI 新增回归已复现失败 envelope 被忽略；修复后全局流 6 项单元通过，确认稳定错误码且不泄露合成诊断正文。桌面新增生产桥接到隔离 HTTP／数据库的两步澄清回归，修复前重复澄清而无法完成；修复后 1 项通过，只有 2 次受控模型调用，70 项迁移重复执行为零且自有测试库清理完成。

实际命令均在 Conda `NotAlone` 下运行：后端目录执行 `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src:. python -m unittest tests.unit.wechat_cli.test_global_session_stream -v`；桌面目录执行 `NOTALONE_DISABLE_DOTENV=1 node --test --test-name-pattern='同一命令多步澄清' tests/reply-continuation-public-http.test.mjs`。没有运行外部模型、实际 App 或微信，没有扩大读取或发送范围。

## 纯显隐切片的工程合并

只迁入窗口策略，不迁入旧分支的任务生命周期接口或冲突 ADR。当前 `onLifecycle` hooks 原样保留：真实聚焦、隐藏及关闭仍通知现有前台与回复控制器；不通过快捷键伪造聚焦。显式 `open` 继续等待观察并聚焦，快捷键走私有展示路径，只 `showInactive`；macOS 使用非激活面板，整体隐藏恢复不调用 `app.show` 或操作管理窗。新建面板后显式应用置顶状态，避免面板默认浮层覆盖用户关闭置顶的选择。

`activate` 只在事件和实际窗口列表均没有可见窗口时恢复管理入口。`index` 只替换导入和该注册点，权限、受管首启、更新及退出收尾接线不变。复制桥保留捕获的原窗口及现有 `hide` 路径，其真实隐藏事件仍经过当前 hooks，不引入旧 `onTaskLifecycle` 或额外包装接口。

Context7 在本会话不可用，核对 [Electron 窗口 API](https://www.electronjs.org/docs/latest/api/base-window#winshowinactive) 与 [activate 事件](https://www.electronjs.org/docs/latest/api/app#event-activate-macos)，并确认项目锁定且安装的 Electron 44.7.0 类型声明包含上述接口。文档和合成边界不认证真实 macOS 焦点、中文输入或系统权限体验。

新增窗口回归先复现快捷键等待 `beforeShow` 的失败；修复后 `node --test tests/helper-shortcut-window.test.mjs tests/candidate-copy/controller.test.mjs` 共 31 项通过，覆盖实际注册回调、连续切换、最小化、整体隐藏、管理窗激活、显式打开、复制隐藏及退出。只替换原生窗口边界，未启动 Electron App、微信或外部模型。
