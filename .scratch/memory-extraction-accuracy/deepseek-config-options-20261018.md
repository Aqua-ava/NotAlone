# DeepSeek 官方配置查证（2026-10-18）

本轮仅查官方文档；未读取凭据、调用模型、变更产品配置或启动预算。文档支持接口约定，不证明本账号可用性、后端真实权重或任务07质量。原失败、主16与诊断8的分母及空放行保持。

## 当前可选模型与公告差异

- 当前定价页分别列 `deepseek-flash` → `DeepSeek-V4.1-Flash-1017`、`deepseek-v4-pro` → `DeepSeek-V4-Pro-0813`；均列工具调用、思考/非思考模式，1M上下文、最大384K输出。文档层面仍是两个独立选项。[当前模型表](https://api-docs.deepseek.com/quick_start/pricing/?model_version=DeepSeek-V4-Pro-0813)
- 10月17日更新明确 Flash 升级1017且调用名不变；旧 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 是转到新Flash的兼容名，不宜作为独立模型对照。[更新日志](https://api-docs.deepseek.com/updates/?release=deepseek-coder)、[当前调用入口](https://api-docs.deepseek.com/)
- 9月10日公告曾预告9月14日04:00 UTC后Pro请求转向Flash；后续官方说明改为应用户需求在9月14日后继续提供Pro API且计费不变。现行模型表仍列Pro0813及独立价格，因此不能依据旧公告断言Pro现在必然被转发；也不能仅凭文档保证每次请求的后端身份。[旧公告](https://api-docs.deepseek.com/news/news260910/)、[保留Pro说明](https://api-docs.deepseek.com/quick_start/pricing/?helper=penn&method=individual)
- 不从“Pro”名称、参数规模或通用基准推断本任务更准确；所需比较对象是来源忠实度、分类/纳入、歧义与自动采纳错误。[旧公告的通用性能主张](https://api-docs.deepseek.com/news/news260910/)

## Chat Completions配置约束

- 接口模型枚举为上述两名；`thinking.type` 为 `enabled/disabled`，默认enabled；`reasoning_effort` 为 `none/low/high/max`，none关闭思考，其余开启，默认high。对照显式传一致且不冲突的开关/档位，不依赖默认值。[接口定义](https://api-docs.deepseek.com/api/create-chat-completion/)
- thinking下 `tool_choice=required` 或指定函数名会400；带tools默认auto。不能为追求强制结构化输出而悄悄把思考模式改掉。非思考仍支持required/指定函数。[接口定义](https://api-docs.deepseek.com/api/create-chat-completion/)
- thinking下 `temperature` 不生效，因此Emax+temperature0不是确定性保证。按分模型指南：Flash的top_p在thinking有效且最小0.95，非thinking固定1；Pro在thinking忽略top_p，带tools固定0.95、无tools固定1，非thinking才生效。只改模型名能保持请求字段，不能保证有效采样策略相同。[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- 同一指南要求带tools的后续请求完整回传先前 `reasoning_content`，否则400；单次E/V不能据此宣称多轮工具链已验证。本轮不新增多轮调用。[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- `max_tokens` 范围1–393216；未设时非thinking为8K、thinking为64K、max档128K。必须冻结既有显式输出上限；若原场未显式设限，不能把调用次数上限误称成本上限。[接口定义](https://api-docs.deepseek.com/api/create-chat-completion/)

## 公开价格（USD / 百万tokens）

| 模型 | 谷输入命中 | 峰输入命中 | 谷输入未命中 | 峰输入未命中 | 谷输出 | 峰输出 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-flash | 0.003 | 0.006 | 0.15 | 0.30 | 0.60 | 1.20 |
| deepseek-v4-pro | 0.022 | 0.044 | 0.66 | 1.32 | 1.98 | 3.96 |

价格及计费单位来自[当前模型价格表](https://api-docs.deepseek.com/quick_start/pricing/?model_version=DeepSeek-V4-Pro-0813)。峰时为周一至周五UTC 01:00–04:00、06:00–10:00（UTC+8为09:00–12:00、14:00–18:00），中国法定节假日除外；其他时间含周末/节假日为谷时。10月18日是周日，按该表属谷时，实际费用仍依实际请求时间和usage；不要将目前谷价永久冻结为报价。

同量token且同缓存条件的推算：Pro未命中输入约Flash的4.4倍、输出3.3倍、命中输入约7.33倍；这不是真实工作负载总价比。成本按各场命中输入、未命中输入、输出实际usage分别乘单价，思考额外输出量和时延须实测，不用“每窗价格”冒充已知值。

整合方提供的fewshot41次usage为输入124651、输出5128（E22次62091/2570；V19次62560/2558）；若Pro使用相同token量且全部cache miss，按表计算峰时约$0.185、谷时约$0.0925。这里只核算公式，未独立重扫原始usage；真实Pro输出/缓存不保证相同，按48/41外推也只是预算参考，不是硬上限。

## 可执行前提与一个有界对照建议（未启动）

1. 如下一步决定做模型干预，预注册两臂：Flash/Flash与Pro/Pro（E/V）；只改E/V请求模型名，其余原文、Gold、提示、schema、工具选择、E/V均disabled/none、输出/时间上限、编译和审核规则一致。最新[fewshot记录](reference-agent-fewshot-result-20261018.md)第5行实际是E/V均非思考；改为Emax会增加第二变量，不能称只改模型。它检验整条E/V组合，不能把变化单独归因E或V。
2. 每臂固定原16主集、最多32次E/V；另设诊断8、最多16次E/V，独立分母与收据。两臂合计请求硬上限96，零重试，安全/技术/语义未知即停，未跑保留unrun；未用额度关闭。不按旧失败选择性重跑，不将既有Flash历史场冒充同时间配对臂。
3. 新场前离线冻结预算、源代码/提示/输入/Gold摘要及两臂唯一字段差异，并依已冻结token上限计算最坏成本；若这些尚无数值，先补齐方案，不能开始。方案需要协调决定，本文件不构成启动记录或新预算授权。
4. 实际响应需核请求名、返回model、system_fingerprint、finish_reason、usage和捕获完整性；文档的模型列表接口可描述能力，但列表/返回名仍不能证明真实权重快照。遇路由/字段不符即停止，不能静默替代。[响应字段](https://api-docs.deepseek.com/api/create-chat-completion/)、[模型元数据接口](https://api-docs.deepseek.com/api/list-models/)
5. 独立Agent按原Gold检查来源和输出，主16仍要求假事实0、错人0、一般错误≤1、歧义不auto；诊断8单列。一次成功只证明冻结配置本次结果，不能据此生产放行或断言Pro普遍优于Flash。

代码前置条件尚未实现：`backend/src/notalone/memory_extraction/evaluation_provider_contract.py:135–136`的official profile固定返回`deepseek-flash`，`:345–347`也固定校验该返回名。正式Pro场需要runtime owner新增封闭profile、精确响应身份校验及冻结测试；不能仅改`.env`或放宽接受任意model。本轮只读核实这两处，没有修改或绕过。

## 证据边界

部分官方页面直接open超时，本文对应内容通过同一官方域的搜索索引返回，定价页/保留Pro脚注可能有抓取时间差；当前首页直接读取确认1017，定价与API枚举交叉支持两模型。参数指南比通用接口页更细地列出Pro的top_p差异，实际SDK序列化、参数接受、有效采样、身份、成本及任务质量仍需有界实测。本轮仅新增本文件，未读取私人资料或触碰业务数据库。
