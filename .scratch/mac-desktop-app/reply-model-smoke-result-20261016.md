# 当前签名 App 官方 DeepSeek 合成回复实跑

日期：2026-10-16。结论：本场 **1／1通过，37.9秒，runner exit0**。当前v6签名App经公开“生成候选”按钮、生产认证HTTP／回复服务／运行时、官方DeepSeek及隔离PostgreSQL，完成一次显式草稿改写、依据保存、候选显示和本地编辑，最后正常菜单退出。只认证本场验收模型装配与短合成草稿，不认证默认生产模型配置、关系上下文、总体质量或微信渠道。

## 固定合同与实际结果

执行合同见[准备及冻结计划](reply-model-smoke-plan-20261015.md)。新run为`7c90226e-618c-4c6d-b430-991276cc98f9`；官方`deepseek-flash`，唯一地址`https://api.deepseek.com/chat/completions`，`reasoning_effort=none`、零重试、最多1次HTTP、生产20秒生成时限、App调度5分钟／最多1次启动。没有挪用已关闭记忆评测run的余额。

| 项目 | 实际证据 |
| --- | --- |
| 当前包 | v6；ASAR `7ed7f0c34f5c059cc848c59e2e6e0bfffb72fd61680fc781be8f7a43d9c3cd27`，启动前deep／strict签名核验通过 |
| 本场配置 | `11a91791dbdbb8b9f4a9a593c275e5e6601ad10756268fc4a39798747972007a`；完整源码、prompt、工具schema、SDK及输入随配置冻结 |
| 输入 | 合成联系人；草稿“明天我有空，晚点见。”；要求“更自然一点，保留原意，不添加新事实。”；关系语境关闭 |
| 请求 | 1次预约、1次HTTP响应、状态200，响应模型吻合；计量payload与实际发送JSON的规范化摘要均为`c7d25cbeaa397b5f1c6d8cc62c7dc20782c94e9f1216be763c5580f48b63934a`，不宣称原始HTTP body字节摘要 |
| 保存 | 认证GET成功，同一联系人／助手会话的唯一turn为completed，依据类型恰为`user_draft`；PG回复记录为completed，未使用Skill。未逐字比较持久候选／依据正文与UI |
| UI | 实际生成3条可编辑候选；Computer Use读取同一存活小窗，确认原句及两个轻微语气变体，并将候选1改成“合成本地编辑，未复制或发送。” |
| 预算 | 持久回执`request_limit=1`、`reserved_requests=1`、`closed=true`；先闭账，再保留小窗供Computer Use核对 |
| 退出 | 本地编辑断言通过，公开菜单正常退出、App exit0；测试报告37.9秒，全runner38.1秒 |

App显示估算总量34843／65536（含输出预留2048、安全余量16384）。这是本场UTF-8完整JSON加framing的近似策略，不是真实tokenizer或最大上下文认证。模型装配使用计划中冻结的验收专用双纯text system块无损序列化适配；本场成功不修复或认证默认DeepSeek适配器。

## 数据与清理

生成前及保存后，隔离库的消息、来源、已确认记忆、记忆候选、后台任务均为0。只向官方模型发送本场合成草稿及生产提示／工具schema，没有真实聊天、关系资料、原始截图、微信读取、CLI、原生探针、复制或外部聊天发送；未修改系统权限，未push。

后端实际收尾核验精确测试库不存在；最终持久收据`budget_close_confirmed=true`、`cleanup_confirmed=true`、`unconfirmed=[]`，保留预算记录及脱敏产物。Root另核本场已记录App／后端／worker三个PID和两个临时路径均不存在。随后出现的桌面租约属于其他会话，未终止或归档；本场正常退出不以该租约仍存在判为清理失败。

本机忽略产物目录`desktop/artifacts/reply-model-smoke-real-20261016-7c90226e-618c-4c6d-b430-991276cc98f9/`保存`run.log`、`reply-smoke-provider.json`、`reply-smoke-closed.json`及Playwright的App／资源收据；原始界面未提交。启动命令为已激活Conda环境下的`npm run test:app -- --interactive --coordinator root-reply-smoke-v6 --from <本场开始> --until <五分钟截止> --max-launches 1 tests/reply-model-smoke-app-acceptance.spec.ts --output artifacts/<本场目录>/playwright`，具体run／配置／包摘要通过计划列明的显式环境参数传入。

此前离线24项、类型、默认关闭及两轴检查分别保留在准备计划。任务20仍需当前包独立启动权限及系统快捷键；本次不以分项成功关闭整票。
