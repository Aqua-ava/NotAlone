# 三组任务自主实施与本地集成记录

日期：2026-10-11。总协调目标覆盖 29 张任务；本记录是实施台账，不替代原任务的验收标准或 State。

## 本轮授权与边界

- A：持续会话 07–18，共 12 张。复用现有会话「实现持续会话的12项任务」。
- B：聊天回复策略 01–11，共 11 张。未找到可唯一识别的对应用户会话，采用实现子 Agent。
- C：真实表达 01–06，共 6 张。未找到可唯一识别的对应用户会话，采用实现子 Agent。
- 用户不参与本轮实施验收。仅使用合成资料、可控模型、隔离 PostgreSQL 和受限普通页面自动测试。
- 排除持续会话 19、原 Mac／微信和记忆质量未完成任务、OCR、真实微信、外部发送、私人资料、媒体提取、云端、Windows、真实 App、外部模型调用和新增预算。
- 仅本地提交和集成；不 push、发布或部署。

## 载体与归属

共同基线：`f18851b2f6c2aed90bf94af11c2ff8f6aea14897`。

| 角色 | worktree | 本地分支 | 归属 |
| --- | --- | --- | --- |
| 总协调 | `/Users/local-user/learn/NotAlone` | `codex/autonomous-integration-29` | 依赖协调、顺序集成、公共接线冲突、真实集成复核与汇总 |
| A | `/private/tmp/notalone-a-session` | `codex/assistant-session-continuity` | 助手会话身份、持久化、版本、预算、取消、恢复和生命周期 |
| B | `/Users/local-user/.codex-account2/worktrees/reply-strategy-b/NotAlone` | `codex/conversation-reply-strategy-b` | 场景输入、理解与方向探索、Skill 延续、消息组和连续场景 |
| C | `/Users/local-user/.codex-account2/worktrees/authentic-expression-c/NotAlone` | `codex/authentic-expression-c` | 离线保真报告、保真契约、表达样本生命周期和生成参考 |

旧 B/C worktree 和分支保持原状；不将存在旧 checkout 推断为本轮活跃负责人。每张任务只有上表对应的实现负责人。

## 公共契约

- 保持 `GenerateReply`／`ReplyService` 统一生成链。B 扩展 `InitiateConversation(purpose: ConfirmedDirection)` 与明确关闭的 `NoSkill`，不伪造目标消息。
- 助手会话的稳定身份、输入版本、取消和恢复由 A 持有。探索建议通过建议 ID 和有效输入版本确认；B 不另造会话存储。
- C 的样本作为独立、低权重说法参考，不是事实证据，也不进入方向探索。确定性结构／范围检查与人工语义审阅分开。
- 按 ADR-044，删除助手会话保留此前已成功主动保存的独立样本；删除原始来源仍清理两者及传递派生内容。样本不保存或恢复会话全文。
- 迁移预留：A `048`、C `049`、B `050`（仅实际需要时）。后续编号由总协调安排。
- 公共路由、装配、生成器、模型载荷、删除事务和桌面桥接只按所属主题做薄接线，总协调逐提交合并并验证。

## 依赖执行顺序

- A 首先交付 07；08／09／10／11／12 可各自继续。13 等待 11＋12，14 等待 07＋12，15 等待 11＋14，16 等待 10＋14，17 等待 08＋14，18 等待 10＋11＋12。
- B 首先 01，随后 02／04；03／07 等待 02，05／06 等待 02＋04。08 等待 04＋A11，09 等待 02＋A16＋A17，10 等待 05＋06＋08＋A13＋A15，11 等待 03＋07＋09＋10。
- C 首先 01 和 04；02／03 等待 01，05 等待 02＋03＋04，06 等待 05＋B10＋B07＋A08＋A09。
- 前置尚未集成时处理其他可执行切片；不得将下发任务或 mock 通过记为集成完成。

## 验证记录

环境已核对：Conda `NotAlone`，Python 3.12.13、psycopg 3.3.4、langchain 1.3.15。非交互 shell 先加载 `/Users/local-user/miniconda3/etc/profile.d/conda.sh` 再激活环境；测试明确指定当前 worktree 的 `PYTHONPATH`，禁用 dotenv 和外部 tracing。

页面租约初始只读状态为 `absent`。页面验证由总协调使用 `test:pages` 串行、有限时段执行；复用生产控制器、认证回环 HTTP 和每场景独立随机 `_test` 数据库。真实 App、系统剪贴板和自然语言模型质量须单独区分，不由页面或合成结果推断。

本轮实现结果、逐项证据、未执行项及提交将随交付补入。本记录当前不宣称任何一张任务已实现或验收通过。
