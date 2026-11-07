# 同步减负 07：保留候选生成的真实失败原因

日期：2026-11-07。范围：独立工作树中的候选 IPC 安全文案与 React 面板，不涉及同步恢复实现。

## 结果

- 同一请求生成报错后，状态为 `not_found` 时保留原始安全错误；再次核对同一请求也不覆盖。未收到状态、`preparing` 和 `unknown` 的原核对方式保持不变，不自动重发请求。
- `discussion_source_unavailable` / `history_source_not_available` 统一显示“聊天来源待重新核验，请到联系人页处理同步问题。”；已落库失败状态同样显示。未知后端错误仍由 IPC 白名单隐藏供应商正文。
- “处理同步问题”复用现有打开管理后台能力，用户再在联系人页使用既有同步问题入口；不自动执行修复。窗口打开失败显示独立提示，保留原因及入口。
- 来源失效时继续撤下草稿、选稿携入、候选与依据；联系人或会话切换清除失败说明，旧回包不能恢复。

## 测试接口与 TDD

任务单指定的接口为候选面板的真实 React 渲染/事件和候选 preload→主进程 IPC。浏览器用合成 IPC 响应替代后端，无 SQLite、真实联系人、真实读取器或模型调用。

| 切片 | Red | Green |
| --- | --- | --- |
| 生成被拒 + `not_found`，含再次核对 | 实际被覆盖为“尚未找到原请求” | 保留真实原因，通过 |
| 来源待核验的处理入口 | 缺少“处理同步问题”按钮 | 出现按钮并调用现有窗口桥，通过 |
| 主进程已知来源错误映射 | 仍返回旧“来源已失效”说明 | 统一安全中文，通过 |
| 已落库来源失败 | 被通用“参考资料发生变化”覆盖 | 保留来源核验说明与入口，通过 |
| 来源失效撤下草稿 | 新文案未匹配旧失效清理条件 | 同样撤下草稿/候选，通过 |
| 打开管理后台失败 | 覆盖来源原因且入口消失 | 独立提示并保留入口，通过 |

实际执行命令（均在 `desktop/`）：

```bash
node --test --test-name-pattern='生成被拒且请求未落库' tests/sqlite-reply-candidates.test.mjs
node --test --test-name-pattern='来源待核验错误' tests/sqlite-reply-candidates.test.mjs
node --test --test-name-pattern='已知失败按安全中文状态映射' tests/sqlite-reply-candidate-bridge.test.mjs
node --test --test-name-pattern='已落库来源核验失败' tests/sqlite-reply-candidates.test.mjs
node --test --test-name-pattern='生成被拒且请求未落库|来源待核验错误|已落库来源核验失败|生成报错后已受理' tests/sqlite-reply-candidates.test.mjs
npm run typecheck
node --test tests/sqlite-reply-candidates.test.mjs tests/sqlite-reply-candidate-bridge.test.mjs
```

相关模块 43/43 通过，其中新增四项 React 行为用例。最后两处来源撤下/窗口失败修订后复跑受影响单例及 `npm run typecheck`，均通过；未重复无关检查。没有因为错误保留而增加生成、状态或正文读取请求。未改默认测试分类或放宽断言。

## 数据影响与边界

零数据库迁移、零业务库写入、零模型调用、零外部聊天发送。仅在当前渲染范围的内存引用中短暂保存一份已由主进程脱敏的错误文本与请求键；联系人/会话切换、资料失效和新生成时清除，不持久化或上传。测试只使用合成文字和标识，不记录真实姓名或聊天。

复用已有安装依赖，未启动或重启 Electron、微信及真实读取器，未点击任何修复同步；未构建或运行打包版。现行回复规格已同步，无 ADR 决策变更。

## 未覆盖与风险

用户明确禁止切换或重启真实应用，因此没有在运行中的 dev 应用做 Computer Use 验收。这里验证了真实 React、headless Chrome 和合成窗口桥，不能证明真实管理窗口切换、联系人页定位或视觉样式已验收。按钮复用 `.button`；不修改样式。实际管理后台可能停留在其他页，需要用户进入联系人页的既有处理入口。

独立双轴代码审查与公开历史检查由本轮主 Agent 汇总。

## 独立审查

相对 `64376743d` 的待提交改动：Standards 0 项、Spec 0 项，无阻断问题。审查分别由未参与 07 实现的 Agent 完成。
