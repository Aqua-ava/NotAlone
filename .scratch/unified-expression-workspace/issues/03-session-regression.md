# 统一工作区助手会话页面回归

Triage: ready-for-agent
State: resolved

规格：[统一表达工作区](../spec.md)。继续适配6个会话页面文件，保留已有入口替换，按当前工作区输入及候选版本语义校正恢复、目录、携入和长历史测试。

## 范围

- assistant-session.ts、assistant-session-recovery.ts
- assistant-session-catalog.ts、assistant-candidate-carry.ts
- assistant-session-full-history.ts、assistant-session-combination.ts

仅测试修改。保留会话隔离、来源删除、幂等、持久化候选版本及未保存编辑边界，不改生产代码。页面复验仍由单租约串行回归任务执行。

## Comments

- 2026-10-20：回归协调任务交接这6文件，原有机械替换由本任务接管；分组独占，禁止争用浏览器。

## Answer

6个会话文件均已完成统一工作区语义适配，保留回归任务原有入口替换。另修正第一批 `reply-strategy-lifecycle.ts` 一处断言：历史动作应从已保存轮次输入核对，回选会话会重置当前输入选项，不应要求当前按钮默认动作等同历史动作。

- 恢复：明确保存候选修改版本，再留一份未失焦编辑；断线／重建只恢复已保存版本，临时想法与要求不恢复。来源无关讨论显式关闭背景，依赖来源讨论显式开启。
- 持久化／目录：同输入同键公开命令重放、回选历史会话、另一客户端改变current后仍沿本次明确会话生成、失败切换保留保存版本、无资格时两个动作禁用。
- 携入：逐条编辑工作区候选，核对精确候选、版本和选择身份；临时想法／要求不携入，旧会话不变、没有自动模型调用。
- 长历史／组合：保留四份10万字完整存量读取；预算在prepare阶段409且零执行请求／零模型；新消息不自动生成，刷新后显式动作才纳入；版本、双联系人、恢复、预算、携入和删父级联均继续覆盖。

验证：2026-10-20运行 `npm run typecheck` 与限定本批文件的 `git diff --check` 通过。未运行页面或启动Chrome、开发服务，没有生产数据处理变化。

待统一串行复验的case：assistant-session-persistence、assistant-session-recovery、assistant-session-recovery-guards、assistant-session-combination、assistant-session-catalog、assistant-session-catalog-guards、assistant-session-full-history、assistant-candidate-carry；以及一行断言修正对应reply-strategy-confirmed-lifecycle。页面运行结论由串行回归任务继续记录，本记录不表示页面已通过。
