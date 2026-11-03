# 页面状态连续性修复验收

## 范围与行为

继续处理 Skill、记忆预加载之后发现的六类问题：候选编辑被临时禁用清除、小窗重开清空讨论、用量刷新清空统计、联系人聊天切页丢失阅读位置、已保存关联重复读取、设置非秘密草稿丢失。

- 临时禁用只暂停新候选操作，不销毁已显示候选和未保存编辑；范围、桥或来源失效仍清除。
- 小窗重开保留同范围已核验讨论，同时继续正式来源核验和生成恢复；不跳过后台检查。
- 用量面板保持挂载，已有统计切页即显示，隐藏时不发起刷新；可见时保留成功统计并合并在途刷新，读取失败、断线立即撤下。关联读取按连接代次、操作代次及读取意图合并；明确读取微信名单和授权写入不能借用旧读取。
- 管理窗口仅在内存保留当前联系人范围的一处消息标识与偏移，不保存消息正文。切页恢复阅读位置；隐藏期间失效、换范围或权威空列表清除位置。初始 IPC 回包前的空白帧不能覆盖锚点。
- 非秘密设置草稿只存在当前窗口内存，按已保存基准复用，保存成功、配置或连接变化后清理。同一表单保存期间，切页返回仍显示保存中并禁用输入；请求结算后再编辑，避免旧回包覆盖新输入。API Key 仍是组件局部输入，不随切页保留，也不进入跨页保存状态。

## 同工作负载对照

以下为生产逻辑配合隔离合成数据的可控对照，不代表真实服务延迟。

| 工作负载 | 修复前 | 修复后 |
| --- | --- | --- |
| 每次候选读取延迟 120ms，临时禁用再启用三轮 | 4 次 GET；编辑保留 0/3；空白 149/154/155ms | 1 次 GET；编辑保留 3/3；空白 0/0/0ms |
| 小窗恢复讨论读取延迟 120ms | 空白约 121ms；正式 GET 1 次 | 保持 ready；空白 0ms；正式 GET 1 次 |
| 同一代次两个重叠的已保存关联读取 | 6 次 GET | 3 次 GET |
| 同一联系人滚到 200px 后切页返回 | 跳至 1466px | 保持 200px |
| 用量后台读取挂起期间重进设置三次 | 清除已有统计 | 统计持续可见；首次读取加共享刷新共 2 次 |

## 验证与限制

自动回归覆盖临时禁用与取消删除、来源失效、延迟回包、读取意图、重连、隐藏空列表、设置保存和密钥清除。测试分类登记通过，无新增依赖、模型请求或外部消息发送。

隔离工作树中，类型检查通过，167 个不同的相关用例通过：候选／讨论 75，用量／关联 35，设置 28，聊天 29。重复运行的子集不重复计数；验证命令均从 `desktop/` 执行：

```sh
pnpm run typecheck
pnpm run test:inventory
node --test tests/sqlite-reply-candidates.test.mjs tests/sqlite-discussion-session.test.mjs
node --test tests/assistant-session-projection.test.mjs tests/assistant-generation-stop.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-deletion-guards.test.mjs tests/sqlite-discussion-source-lifecycle.test.mjs tests/sqlite-discussion-bridge.test.mjs tests/manual-confirm-session-recovery.test.mjs
node --test tests/usage/controller.test.mjs tests/usage/react.test.mjs tests/usage/bridge.test.mjs tests/binding-startup.test.mjs
node --test tests/usage/continuity-view.test.mjs
node --test tests/setup-view.test.mjs tests/first-frame-read.test.mjs tests/startup-continuity.test.mjs
node --test tests/contact-chat-timeline-view.test.mjs
node --test tests/contact-history-controller.test.mjs tests/contact-history-quotes.test.mjs tests/contact-history-quote-view.test.mjs
```

候选最终版本移除了在途讨论恢复合并，随后重跑相关五文件 35 例通过，继续保留每次真实重开时的恢复行为。额外尝试的 `desktop-interaction-view.test.mjs` 因本机没有默认 Playwright headless-shell 而无法启动；本次页面回归使用已安装的 Chrome。该缺口不作为已通过用例计入。

日常开发仅复用 `pnpm run dev` 实例，未制作发布包。Computer Use 实际选择已保存联系人，将聊天滚到中段，切到设置再返回；前后截图中的同条消息及偏移一致，“回到最新”仍可用。截图和私人聊天内容不落仓库。检查早期曾遇到本机服务未连接，服务自行恢复后才完成上述操作，未调整数据库或同步范围。

Computer Use 还验证快捷键、Base URL 的未保存输入在联系人页往返后保留，密钥框保持空白；随后将输入恢复原值，没有提交设置或发送消息。保存中切页、失败、规范化结果与连接变更用合成数据验证，避免改写真实配置。

## 最终集成复核

同步和新读取器验收明确释放后合入主目录。按最新联系人操作接口保留 `actions`、`syncDetailsContactId` 及同步诊断，时间线测试仅追加本任务用例，未回退现有断言。最新主分支隔离合并副本通过类型检查及 71 项相关检查；主目录合入后类型、测试分类检查和 50 项控制器／生命周期回归通过，重复用例不另计为新的独立覆盖。原新读取器路径、联系人授权、同步开关及业务资料均未修改；临时集成副本清理，保留开发实例。
