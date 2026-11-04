# 02 — 正常候选入口改为单次模型调用

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 01

按 [spec](../spec.md) 在正常 SQLite 候选回复路径中预加载全部 eligible Skill，使 Skill 使用不再产生“模型选择 + 工具加载 + 最终生成”的额外模型往返。

## What to build

- 候选装配冻结目录后，选出全部 `enabled + verified + current` 的 Skill。
- 在创建 Agent 前通过受控 provider 读取全部 Skill 正文，并加入初始系统上下文。
- 正常预加载路径不向模型暴露 `skill` 加载工具，避免再次发布可调用的 Skill 摘要目录。
- 保留 `skill_resource`，仅允许读取本轮已预加载 Skill 的声明资源，最多两次。
- 没有 eligible Skill 时正常走无 Skill 单次模型调用。
- Skill 正文导致完整请求预算超限时，整体移除 Skill 并降级为无 Skill 单次调用；不截断正文。
- Skill 读取失败、anchor 失效或目录变化时整体降级，不能带残缺 Skill 继续。
- 保留显式 `selectedPackageId` 路径，并保持其单包选择优先。
- 继续使用 DSH 官方 profile、registry、provider 和 Agent 生命周期。

## Acceptance Criteria

- [ ] 正常入口存在一个或多个已启用 Skill 时，物理 `model_call` 数量为 1。
- [ ] 首次模型请求已包含全部预加载 Skill 正文。
- [ ] 首次请求不出现可调用的 Skill 摘要目录，不产生 `skill` 工具调用。
- [ ] 没有 Skill 时仍只调用一次模型。
- [ ] `skill_resource` 仍受已预加载身份、资源路径和两次上限约束。
- [ ] Skill 失效、预算超限和读取失败均可解释地降级，不静默截断。
- [ ] 显式指定 Skill 的兼容行为保持。

## Tests

- 候选集成 seam：单 Skill、双 Skill、无 Skill、预算超限、失效、显式单 Skill。
- DSH profile seam：实际安装的 `@deepseek-ai/dsh-tool-skill@0.2.1-rc.2` 下验证目录不重新发布。
- 验证所有预加载正文都进入实际请求快照，但不把“预加载”写成“模型已采用”。
- 运行相关候选、Skill、DSH profile 测试和 typecheck。

## Out of Scope

- 不做本地相关性 top-k 排序；v1 预加载全部 eligible Skill。
- 不预加载 Skill 的全部静态资源。
- 不改变记忆、文档或旧讨论装配。
- 不处理 SQLite 后台查询阻塞问题。
- 不新增用户手选 Skill 控件。

## Answer

- 实现：正常候选在创建 Agent 前通过 `openSqliteSkillRun` 多 anchor 入口预加载冻结目录中全部 `enabled + verified + current` 正文；显式 `selectedPackageId` 继续只预加载指定单包并优先于自动集合。预加载正文经 `renderSkillContent` 全部进入初始系统提示。
- 工具边界：预加载运行隐藏官方 `skill` 目录工具，因此 DSH 不再发布 `available_skills` 目录；保留 scoped `skill_resource`，只读取本轮已成功预加载版本的清单内相对路径，整轮最多两次。未触发资源时为一次物理模型调用；触发资源时允许一次额外资源往返，不宣称绝对一次。
- 降级与预算：刷新、anchor 复验、正文读取或资源失效任一失败时清除全部 Skill 输入后走无 Skill 路径；完整请求预算拒绝不计作物理调用，撤下全部 Skill 后重新生成一次无 Skill 请求。已启用但缺失、未核验或当前修订不可用的任一目录项也使本轮整体无 Skill，并记录 `skill_unavailable`，不夹带其余策略。
- 01 复核：确认 `selectedPackageId` 显式优先、自动集合仅在全部 eligible 时进入、逐 anchor 复验 revision／目录身份／manifest／content digest、任一失败关闭运行且不保留部分正文；现有 7 个多 anchor 测试 7/7 通过。复核未发现共享候选装配冲突。
- RED：先替换候选 Skill loop 回归为预加载口径，`node --test backend-ts/test/sqlite-reply-skill-loop.test.mjs` 为 2 通过／8 失败；失败覆盖目录仍发布、正文未进入、目录工具未隐藏、资源身份检查、读取失败与预算超限降级。
- GREEN：同命令 10/10 通过。真实物理请求数：单 Skill 1、双 Skill 1、无 Skill 1、显式单 Skill 1、预算超限降级 1、预加载读取失败降级 1、已预加载后资源失效 2、主动读取两份资源 2（正文首请求 1 + 一次资源往返 1）。
- 其他验证：`sqlite-skill-precall.test.mjs` 7/7；`sqlite-skills.test.mjs` 27/27；后端 `tsc --noEmit` 通过；`sqlite-reply-candidates.test.mjs` 12/15，3 个失败都在启动本机 HTTP 环回服务器时因当前沙箱 `listen EPERM`，未进入候选逻辑。受限环境使用同一真实 SQLite、DSH registry、Agent、provider 和预算链，仅在测试夹具替换 `fetch` 传输为进程内 SSE。
- 数据影响：仅合成联系人、消息和 Skill；未读取真实微信、未调用外部模型、未发送消息、未启动 App 或打包。
- 桌面待验收：尚无真实开发 App 证据；ticket 05 需确认实际页面无手选控件、显示本次预加载 Skill 与降级提示，并由受控日志确认物理调用数。
- 风险：正式 profile 子进程接线已由 ticket 04 的合成测试用实际安装包验证；资源读取与迟到失效后降级会是 2 次物理调用，属于已记录例外，不能宣传为始终一次。

- 集成回归修复：保留的旧式/显式按需加载路径仍同时暴露官方 `skill` 与受控 `skill_resource`；正文载入前资源 guard 继续拒绝访问，避免旧路径在工具集合上退化。

## Comments

- 2026-11-04：按规格创建，依赖 01。
- 2026-11-04：预加载正常入口、工具隐藏、预算/读取/失效整体降级与合成回归完成，等待独立 Standards／Spec 审查；保持 `claimed`。

- 2026-11-04 Spec Review 修复：旧式按需路径原先在安装 guard 时缓存 `loadedSkills.length===0`，官方 `skill` 工具后续载入正文后 `skill_resource` 仍被拒绝。现 guard 每次执行实时检查当前运行已加载正文；只有加载后才能读取该版本声明资源，次数计数与两次上限不变。
- RED：真实官方 DSH／环回模型集成中，首次 `skill` 载入正文后连续两次 `skill_resource` 均返回 `discussion_resource_limit`。GREEN：4 次物理请求完成“载入正文 → 资源 1 → 资源 2 → 最终候选”，输入追踪为 `SKILL.md` 与两份资源，`discussion-generation` 8/8、候选 Skill loop 15/15、正式 profile 1/1，backend typecheck 通过。
