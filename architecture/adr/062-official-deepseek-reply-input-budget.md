# ADR-062：官方 DeepSeek Flash 回复采用完整请求估算

> 状态：已采纳。
> 决策日期：2026-10-16。用户指定生成模型使用 DeepSeek 官方接口。
> 局部修订：扩展 ADR-045 的估算适用范围，不再仅支持 ECNU。

本机已经配置官方 `deepseek-flash`，但生产回复装配只有 ECNU 输入估算，导致极短草稿也返回 `input_budget_unavailable`。该错误来自调用前的长度检查，不代表供应商账户余额或请求次数不足。继续只允许 ECNU 与本次官方接口选择冲突，因此分别核实官方容量并接入同一完整请求估算器。

[官方模型接口](https://api-docs.deepseek.com/api/list-models/)给出 Flash 的上下文总容量为 1,048,576 token，计入输入与输出；[模型说明](https://api-docs.deepseek.com/quick_start/pricing/)确认模型名与官方地址。默认生成模型采用 `deepseek-flash`；仅对 `https://api.deepseek.com`、其 `/v1` 路径及精确 Flash 模型装配官方配置。ECNU 的容量与计量标识保持独立，代理、其他模型及未知路径不继承官方能力。

沿用 ADR-045 的文字完整 JSON UTF-8 字节估算及 4,096 token framing 估算，另计 4,096 token 输出预留和 65,536 token 安全余量，标记 `approximate`。系统指令、完整讨论、检索、工具 schema、结构化输出和有效设置均纳入；每轮重新检查，并绑定真实模型实例、同步与异步 SDK 接收地址及默认参数。此方法不是供应商精确 token 数或已证明上界，不静默裁剪或摘要，真实超长错误仍应保留讨论并明确报告。

真实官方探测另确认默认思考模式与当前结构化输出的 `tool_choice=required` 冲突，会返回 400，符合[官方 Chat 合同](https://api-docs.deepseek.com/api/create-chat-completion/)。共用模型工厂默认固定官方地址和 Flash；未显式选择思考配置的官方 Flash 调用设置 `reasoning_effort=none`，供生产回复与探索兼容使用，并将有效设置纳入完整估算。ECNU 及记忆提取／评测显式指定的思考设置保持；不借兼容修复放宽输出结构校验。

估算只在内存处理，持久回执只含配置与计量元数据。本次不扩大联系人范围、历史读取或外发字段，不引入自动发送；实际 App 验证只证明已操作的生成路径。回归通过生产装配与公开 HTTP 验证短请求、超长拒绝、端点变更拒绝和回执重载，SDK 边界另验证后续工具轮与回复／探索共用计量。

## 2026-10-16 验证记录

`conda activate NotAlone` 后执行 `python -m unittest discover -s backend/tests/unit -t backend -q`，1,505 项通过；官方／ECNU、助手预算、探索、讨论与风格预算六组公开 HTTP 回归在随机 `_test` 库运行，34 项通过，自建库已清理。官方短请求分别复现缺预算的 409 与思考参数冲突的 500，再通过同一生产装配转为 200；双轴独立审查均为 0 项。

Computer Use 在既有 App 复现提示，通过正常菜单退出、重启加载本项目后端，确认原联系人并保持关系语境未勾选，用最小数值草稿触发正式生成。界面显示“生成已完成”，最小出站台账记录 `deepseek-flash / succeeded`，模型耗时 2,836 ms；另有纯合成输入的真实官方调用成功。完成状态后曾遇到 Computer Use `noWindowsAvailable`，重新绑定既有窗口并通过公开“查看已保存讨论”取回两条可编辑候选；历史回执明确显示估算、输出预留与安全余量。记忆提取只核对共用模型工厂实际选择官方 Flash 与同一 `.env` 密钥，未触发私人历史提取或认证其质量；不据此认证完整渠道闭环。未保存私人截图、身份或模型正文，未发送微信消息。
