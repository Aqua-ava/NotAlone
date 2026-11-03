# 助手讨论读取与失败恢复验收

日期：2026-11-03。范围：历史展示、撤下发言的协议、独立草稿和明确新开；不包含真实模型效果、微信发送或发布包。

> 后续复测：本文三次快样本不足以证明性能稳定。同一后台 PID 的扩大采样仍有秒级等待；性能问题尚未完成验收。完整分组、异常样本与测量限制见[耗时复测](assistant-discussion-latency-recheck-20261103.md)。

## 问题与实现

- 原会话读取在配置、历史来源影响和运行副本核验中重复扫描账号范围，实际接口曾耗时 6.65 秒，产品读取链另一次在 8.002 秒超时。
- 复用已进入工作区的实际依赖核验改动；本次将 GET 缩为一次业务历史读取，不运行配置计算或 DSH 恢复。已有副本返回 `unchecked`；生成仍走原有授权、来源、配置及运行副本核验。
- 已撤下发言仅在 HTTP 投影中统一为 `text: null`、`call_id: null`，保留数据库审计字段和桌面严格校验。
- 加载和失败时保留同一联系人独立草稿；失败可重读或明确新开。新开只保留本次独立草稿，不携入旧背景、候选或要求。未就绪时仍禁止生成。
- 草稿回显延迟时保留尚未确认的新输入；联系人范围变化与明确删除仍清空。
- Unified 加载输入区切换至 SQLite 候选工作区后，晚到草稿可以完成一次交接；新编辑和来源失效、撤销、删除会关闭旧草稿交接，避免覆盖或复活。历史会话只读不再阻止失败后的重读与明确新开。

## 性能证据

原版本为 `3d7b7f90882d`；对照为当前实际依赖核验与本次读取改动共同形成的工作区，不能将全部收益单独归因于移除运行恢复。

同一个正式数据库只读连接、同一个 `BEGIN` 快照、同一会话，直接调用两个版本的公开存储动作：

| 项目 | 原版本 | 当前工作区 |
| --- | ---: | ---: |
| `discussion.view` | 1346.82 ms | 0.21 ms |
| 返回发言数 | 2 | 2 |
| 可见发言数 | 2 | 2 |

完整投影逐字段一致；账号采集记录总数为 181963。该检查未写数据库，不输出身份或正文。

复用正在运行的开发实例，用生产 `JsonClient`、`readAssistantSession` 和严格 reader 读取相同会话，三次均接受：345.17、16.34、0.74 ms，均为 2 条发言、`unchecked`。这些是小样本接口耗时，不是屏幕绘制耗时或稳定分位数。

## 验证与限制

- 后端讨论 HTTP、服务、来源撤下、正式 profile 和候选正式 profile 共 30 个回归通过；来源失效后的 HTTP 回包能被真实桌面 reader 接受，仍不展示被撤下正文。
- 桌面回归覆盖加载/失败可编辑、就绪前禁止生成、明确新开保留独立草稿且清空旧背景、迟到读取不覆盖新草稿、删除与联系人范围清理。
- Chrome 组件交互使用合成状态和 IPC 边界替身；加载转换和跨组件草稿交接 8 例、既有候选面板 15 例通过。独立审查发现的晚回显丢字和历史重试按钮门禁问题均先红后绿；相关断言不代表原生微信集成验收。
- 后端与桌面 TypeScript 检查通过。实际 App 复用 `pnpm run dev` 实例；已检查小窗能显示已加载的工作区，不再停留于原来的失败/恢复提示。当前前台联系人未确认时仍禁止生成。
- 本次未创建真实讨论、发起真实模型调用或发送微信消息；未打包，未修改聊天正文或原始审计资料。

主要命令（Node 24.22.1，均在对应目录执行）：

```sh
# backend-ts/
pnpm run typecheck
node --test test/sqlite-discussion-integration.test.mjs test/sqlite-discussion-http.test.mjs test/sqlite-discussion.test.mjs test/sqlite-discussion-host.test.mjs
node --test test/sqlite-reply-candidates-profile.test.mjs
node --test test/sqlite-reply-provenance.test.mjs
# desktop/
pnpm run typecheck
node --test tests/sqlite-first-session-regression.test.mjs tests/sqlite-discussion-read.test.mjs tests/workspace-local-draft.test.mjs
node --test tests/workspace-local-draft-transition.test.mjs tests/workspace-draft-sqlite-handoff.test.mjs
node --test tests/sqlite-reply-candidates.test.mjs
```
