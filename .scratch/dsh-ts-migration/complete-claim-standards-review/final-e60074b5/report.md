# 最终固定候选的 Standards 增量审查

- 结论：`approve`。原 P2 已关闭，未发现本次增量需要修改的 Standards 问题。
- 最终候选：`e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。
- 增量基点：`bcc6701ce67249d18b51625c07f4cad4e401ad04`；原始审查基点：`d4e7690bd9f57a2fae66b04d348219476c0cb497`。
- 范围：9 个共享源码文件的增量及其调用、来源和测试边界；116 个增量路径的 Git blob 身份见 `scope.json`。`b448474a` 的非回复工程结果保持原证据身份。

## 原 P2 关闭

`backend-ts/src/extraction-flow.ts:151` 已把准备调用移入既有核验 try/catch。同一61候选输入在仓库外固定 `bcc` 快照仍抛 `complete_claim_policy_invalid`，在最终 pin 返回 `invalid_output`、`extraction_completed=true`、空 accepted；均 E1/V0。来源撤销、追踪写入失败和取消仍原样传播。见 `delta-first.log` 的第一组探针；原核心报告及探针未改写。

## 增量边界

`extractionRetryPolicy` 为内部构造参数；`host-reply.ts` 透传，`extraction-batch-service.ts` 校验并复制冻结，受控 profile 显式提供0/0。独立合成 PostgreSQL 经公开 Runner→Batch 接缝验证：构造后修改调用方对象仍不重试；省略参数仍保留原恢复资格。未新增重试 HTTP 或环境开关，unknown 门代码保持。

输出配置保持同一模型与授权路径。独立探针将131072带入最终 strict 实体及预约摘要，过时来源或预取消均没有派发；fetch 为完全拦截的合成响应。官方[模型目录文档](https://api-docs.deepseek.com/api/list-models/)分别定义上下文与输出上限，公开示例对应1048576／393216；这不证明真实 API 请求或质量通过。

回复评测显式冻结执行策略及作用域摘要，保留原 primary、适配前后SHA和最终 wire 绑定；假 wire 输出、隐式策略和错误作用域摘要被拒绝。费用豁免保留失败的费用测量结论；usage 未知和严重假事仍阻止通过，分母96保持。无选项的默认报告与 `bcc` 逐字段相等，输入未改写。

## 本轴证据及限制

五组增量探针完成：首次4/5通过，最后一组因本探针错误假定报告顺序而失败；改用 `blind_id` 关联后仅重跑该组，1/1通过。首次日志与执行源码摘要保留；首次探针逐字重建的私有副本与已记录SHA一致。见 `verification.json`、两个 receipt 和日志。

716个最终归档文件前后集合SHA一致；最终 `sourceStamp=f22df426d48d701ef520cdbd6a1262497545b830cbec1dff9b3be4ee92ea5f50`，旧 `bcc` v2 stamp 被拒绝。原核心证据 manifest 仍为 `e0cf7635e1b81c8d051999561c5a9317c3f15d1dc247f06afcfe47a3af12f94d`，所有原文件不变。

仅使用合成文字、独占随机 `_test` 库和0700归档，未读取真实资料、预算配置或原账本。自有库已普通DROP，快照/进程清理见 `cleanup.json`；原日志仅仓库外0600保存。未重跑旧core、全backend、根TSC或真实模型；未操作App/微信、共享index、提交、push或PR，也未读另一轴结果。

本次 `approve` 仅批准上述固定差异的源码 Standards；真实语义质量、实际App及Ticket25/26仍由主协调会话另验。
