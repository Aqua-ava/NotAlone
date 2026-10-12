# ECNU 记忆评测配置复核（2026-10-12）

- 状态：公开文档预检；不代表网关集成、模型身份或记忆质量验收通过。
- 用户已确认继续使用 ECNU。沿用历史 `base_url` 与 `ecnu-max` 作为拟执行的显式配置，不读取 `.env` 来补事实。
- 范围：官方公开页面与既有研究笔记；模型请求 0 次，没有构造供应商客户端，没有读取密钥、环境配置值、私人样本、业务数据库、微信或 App。
- 方法：当前工具目录无 Context7；先使用 `web`，部分页面返回内部错误或超时，再通过搜索连接器读取同一官方页面及其公开检索内容。检索内容标记为约两天前抓取，复核日为 2026-10-12；不能用页面文字证明实时部署状态。

## 可冻结的请求配置

| 项目 | 拟冻结值或规则 | 证据与边界 |
| --- | --- | --- |
| 供应商 | ECNU | 当前用户选择；不切换供应商或模型家族。 |
| `base_url` | `https://chat.ecnu.edu.cn/open/api/v1` | 官方模型页与 SDK 示例一致。[模型介绍](https://developer.ecnu.edu.cn/vitepress/llm/model.html)、[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html) |
| HTTP 端点 | `POST https://chat.ecnu.edu.cn/open/api/v1/chat/completions` | 官方接口地址；预算只允许此精确端点，不调用 `/models` 探测。[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html) |
| 请求 `model` | `ecnu-max` | 继续既有配置；它是服务模型名，不是精确权重版本或部署摘要。 |
| `thinking` | 基线继续显式 `{"type":"enabled"}` | ECNU 文档支持显式开启；省略时默认关闭。[思考模式](https://developer.ecnu.edu.cn/vitepress/llm/thinking.html) |
| `reasoning_effort` | 基线沿用省略，记录为“未发送；服务端实际档位未知” | `ecnu-max` 公布 `low/high/max`，只在思考开启时生效；开启后的默认档位没有明确值。后续改为显式档位必须单列实验配置，不能把旧基线补记为 `high` 或 `max`。[思考模式](https://developer.ecnu.edu.cn/vitepress/llm/thinking.html) |
| `temperature` | 基线沿用显式 `0`，仅表示实际发送值 | ECNU 指出思考开启时采样参数可能受限或无效。不能由请求值宣称输出确定或服务端实际使用温度 0。[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html) |
| 其他可选参数 | 逐项记录实际发送或省略，不补默认值 | `temperature/top_p` 的省略默认与模型有关；文档未给出本轮网关固定值。`stream` 也须由最终请求明确记录。[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html) |

上表属于下一轮拟执行配置；真正冻结还须将最终序列化请求、工具 schema、提取与核验两阶段、超时与 SDK 重试配置一起绑定到同一运行清单和预算计数器。当前没有发送任何请求。

## 服务模型名与返回字段

官方模型页本轮公开内容将 `ecnu-max` 列为 **DeepSeek-V4.1-Flash**，并记录 2026-10-01 升级；同页保留 2026-09-18 使用 **DeepSeek-V4-Flash-0731** 的历史说明。由此可以判断该服务模型名会随平台升级改变底模，不能把它当作固定权重身份。文档没有证明每个请求会动态选择不同底模，也没有公布版本锁定入口、精确权重哈希或逐请求部署证明。[模型介绍](https://developer.ecnu.edu.cn/vitepress/llm/model.html)

通用对话返回参数表没有给 `model` 字段定义身份保证；公开示例中有返回 `ecnu-plus`、`qwen25`、`SparkDesk` 或省略该字段的不同形式。未来响应若包含 `model`，只能保存为“服务返回的型号字符串”，不能据此认证精确权重、补丁或部署版本。[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html)

模型列表文档把列表 `id` 定义为模型名称，示例列出 `ecnu-max`；这也没有提供精确部署身份。本轮只读说明页面，没有调用受鉴权的模型列表接口。[模型列表](https://developer.ecnu.edu.cn/vitepress/llm/api/models.html)

## 思考与工具组合仍须运行验证

ECNU 公布两主模型支持 Tool Calls，并给出 `tools` 的 function 调用示例；通用对话的请求表与示例没有列出 `tool_choice` 的枚举、具名选择形状或“思考开启 + 强制具名工具”的保证。因此本项目已有具名工具请求形状属于待验证的实际客户端契约，公开支持 Tool Calls 不能填补此组合的验收缺口。[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html)

ECNU 说明：思考过程中实际调用工具后，后续轮次须完整回传中间助手消息的 `reasoning_content`；未调用工具时可省略。[思考模式](https://developer.ecnu.edu.cn/vitepress/llm/thinking.html) 当前代码的提取与核验分别构造独立的 `system + user` 输入，核验对空候选不调用模型；是否需要拼接应按实际消息结构确认，不能臆造新的工具循环。[提取适配器](../../backend/src/notalone/memory_extraction/adapters.py)、[核验适配器](../../backend/src/notalone/memory_extraction/verification_adapters.py)

历史发布记录证明平台在 2026-08-10 公布 `ecnu-max` 的思考强度支持；2026-09-18 的发布项仍描述旧底模。日期较早的发布项不能覆盖模型页 2026-10-01 的变更说明，也不能证明本轮请求已被正确执行。[更新日志](https://developer.ecnu.edu.cn/vitepress/llm/release.html)

## 与旧研究的关系

[2026-10-02 思考强度笔记](../../research/deepseek-ecnu-thinking-effort-20261002.md)和[同日替代模型笔记](../../research/ecnu-alternative-memory-models-20261002.md)保留原样。其 `Flash-0731`、`Qwen3.8-27B` 是当时笔记记录的公开页面观察，不改写成当前事实。本轮公开页面观察到的升级记录另外保存于本文；网页内容变更或抓取差异都不能追溯认证旧实验实际底模。

## 仍未知及下一步

- 真实响应 `model`、实际执行的思考档位、温度／采样参数映射与具名工具组合可用性，须在已冻结预算下读取实际响应后记录；目前全部未知。
- 若基线保留省略 effort，评测应明确只能复现请求配置，不能承诺复现服务端默认行为。显式改用 `max` 会形成新候选条件，不静默并入旧基线。
- 实际返回需与请求分别保存；响应缺失型号时记录缺失，发现型号变化时标记该次观测，不自动替换预期底模或宣称身份匹配。
- 标准答案、结果持久化及有界 runner 仍按原记忆任务完成；本文不启动模型实验、不改变采纳放行表、不关闭原票。新增功能继续冻结，OCR 继续暂停。
- 验证：逐项核对上列官方页面与既有研究，检查本文链接及文档格式；本轮只有公开文档读取／检索，没有运行项目测试。初稿按研究路由写入被忽略的 `research/`，主Agent将本轮公开配置复核移入原票准备目录保存，不强制加入被忽略文件。
