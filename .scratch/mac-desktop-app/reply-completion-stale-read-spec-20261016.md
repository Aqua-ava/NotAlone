# 回复完成确认与迟到会话读取

Triage: ready-for-agent
State: resolved

2026-10-16。原桌面20票范围内的最小源码修复。既有合成回放已独立复现该缺陷；它不是 b251 实际失败的已确认根因。

## 问题与目标

旧空会话 GET 在生成开始前已发出，生成完成回执后的新 GET 已取得匹配的完成快照；若旧 GET 先返回并发布，当前实现会仅因它发布较晚而拒绝新候选，留下 idle／result=null。当前输入、完成轮次、请求身份和 active 输入全部匹配且来源有效时，应显示 ready 和本次结果。

## Implementation Decisions

只调整 `desktop/src/main/reply/session.ts` 的既有读取时序：完成回执通过当前范围与连接代际检查后，完成确认读取接管此前仍在途的会话读取。保留后续新读取、真实 current 变化、联系人／助手会话切换、来源失效、宿主隐藏和操作取消的既有优先级。不得按快照为空而豁免，不放宽任何输入或来源守卫，不增加公开接口或架构。

## Testing Decisions

已确认接缝为 `desktop/tests/assistant-candidate-version-ports.test.mjs` 的真实 ContactSession、IPC／preload reply bridge、controller 和 JsonClient；使用自有回环认证 HTTP Mock 控制响应交付，不使用 PG。先将忽略诊断回放的有效 HTTP 交错提升为仓库回归，断言 ready／实际结果并观察真红，再实施最小修复。

正控覆盖正常有序完成和旧读取迟到；负控保留真实 current 不同、较新来源不可用、其他联系人或助手会话、宿主隐藏与操作取消的拒绝。检查全部相关纯 controller 测试和 TypeScript；不以 Mock 结果认证生产存储、真实模型或原生窗口。

## Out of Scope

不修改真实模型夹具、生成等待门、Gold、六份 CLI 冻结源或旧失败报告；不启动 App／GUI／真实模型／PG，不重包、签名或推送。当前源码修复不代表冻结 v9 包已包含变更。完成后交主 Agent 双轴独立审查并由主 Agent 本地提交。

## Answer

本地修复切片已完成，两轴独立审查最终各0项，由主Agent创建本地提交；不关闭原桌面20票或签整包验收。产品只新增完成确认前的 `this.savedRead?.abort()` 及中文注释；原 `acceptLatestRead`、完成身份、来源及取消守卫保持原样。旧读取仍按原 finally 释放引用，随后新发起的读取仍能优先裁定，未新增接口或数据字段。

在 `desktop/` 执行：

- `NOTALONE_DISABLE_DOTENV=1 node --test --test-name-pattern='完成确认的新HTTP快照' tests/assistant-candidate-version-ports.test.mjs`：先写单例并在未修产品时真红，81ms，`idle !== ready`；最小修复后同例49ms通过。随后提升为10个合成交错正负控，10／10通过。两个正控分别为旧空与旧非空读取，均由相同读取接管修复；不是空内容豁免。
- `npm run typecheck`：通过。
- `NOTALONE_DISABLE_DOTENV=1 node --test tests/assistant-candidate-version-ports.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-catalog-read.test.mjs tests/assistant-session-deletion-guards.test.mjs tests/assistant-generation-preparation.test.mjs`：116例，115通过／1失败。唯一失败是未改的 `assistant-generation-preparation.test.mjs:183`，在201行注册身份触发任务容量门。该测试只打包未改的 `assistant-generation-jobs.ts`，不导入本次 session；定向单跑同例也失败，保持原断言及产品容量门，不扩修。
- 去掉上述独立任务管理文件后，其余4份完整相关纯 controller／读取／删除测试101／101通过。
- 主Agent另以同一名称模式独立复跑新增10个交错用例，10/10通过、325ms；它们包含在上述相关组内，不重复累加。
- `git diff --check`：通过。

负控实际拒绝了权威 current 变化、完成确认期间较新 current 变化、来源不可用、较新来源不可用、其他联系人、外来助手会话快照、宿主 hidden 和用户改稿使操作失效，均无本次结果恢复。较新来源读取会使既有 job reconcile 废弃本次发布资格，但公开 phase 仍可保留 waiting；该例只认证未恢复正文，不认证退出 waiting，本补丁不扩修这个旁支。公开切换助手会话在 waiting 时本已有拒绝门，因此外来会话负控从完成 GET 的错误 session_id 验证，不绕该门强切。

本次只处理合成常量与随机身份；自有 HTTP server／client 均在测试收尾关闭，没有新持久化数据、真实联系人或外发。未运行 PG、App、GUI、真实模型或重包；旧 v9 ASAR 与六份 CLI 冻结源不变。b251 实际根因仍未知，本修复只关闭独立复现的读取交错缺陷。
