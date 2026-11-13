# 任务07独立V推理与工具策略联合计划

[上一联合场](reference-retention-result-20261018.md)已closed10/32：4窗safe3／一般1，A01 V仍误拒有据第三人转述；A05响应无法留证而unknown，后11窗unrun。`nested_json_invalid`只说明某个嵌套arguments／body_text字符串无法解码，正文未保存，未证明更直接的程序缺陷；不能宣称本方案修复该失败。

## 配置变化与目的

只在新独立reference身份中保留E为Pro disabled／none／named forced，将V改为Pro enabled／max并省略tool_choice；两阶段max_tokens仍8192。V推理与必要兼容工具策略共同变化，不称单变量因果实验，也不保证解决A01语义误拒或响应格式问题。

[官方接口合同](https://api-docs.deepseek.com/api/create-chat-completion/)及[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)允许推理与工具调用，但思考模式不能强制required或指定工具；带tools省略tool_choice沿auto。缺工具、多工具、截断、响应身份错误或留证失败仍立即停止，不补强制调用、重试或修补模型输出。8192可能被推理消耗，temperature=0不代表推理输出确定性。

## 独立冻结身份

- provider `deepseek-pro-reference16-v-thinking-v1`；plan `reference16-pro-retention-v-thinking-v1`；mode `deepseek_bounded_reference16_pro_retention_v_thinking`；stage／kind／fixture `reference16-pro-retention-v-thinking`。
- 整数request_contract_version为6，字符串phase_request_version为`deepseek-reference16-v-thinking-v1`。独立phase_policy明确E disabled／none／forced与V enabled／max／omitted，不沿旧全局thinking或reasoning字段解释新场。
- 模型请求和响应都精确`deepseek-v4-pro`。E维持grounded-v2＋reference-kind-teaching-v1，V维持legacy-v4＋reference-retention-v1；提示、schema、编译器及A05有限理由说明沿统一基线，不改变Gold或语义信用。
- 原21 Gold只选择原A01–A16：16窗、18必需＋1可选、上限32次、零重试、原300秒请求／600秒阶段／14380秒工作／14400秒外层期限。D8仍不登记，不删除旧失败或reason_rule缺口。
- 新来源集合在retention集合上增加本计划。每次真实场必须使用新run、私有目录及冻结源码／版本／输入／Gold／提示／schema哈希；prepare不读取凭据或建立预算，loader领取后才读私有单键JSON。
- 旧三个reference身份、core及bounded各自合同保持，不能把本新档放入bounded或原E max／V none的mixed集合。新provider与plan严格一对一绑定，禁止通过重算摘要混配。

## 接线与验证边界

复用已有runner、严格记录器、Main16Deadline、owned进程和RAW→FULL桥。新档须独立构造V模型及V recorded wrapper，并显式关闭强制工具选择；不能复用E模型，也不能依赖仅识别Flash的生产thinking检测函数。任何实际HTTP参数与冻结phase policy不同须在发送前拒绝。

先以禁网Mock验证实际E请求不变、V请求精确enabled／max／8192且完全没有tool_choice；覆盖旧档字节、跨profile／plan／阶段错配、冻结漂移、record／owned／bridge闭环，以及末窗unknown不算完整。缺／多工具、截断、坏JSON、响应身份及capture gap仍单次硬停。

本次安排仅实施离线闭环、独立Spec／Standards审查与本地提交，不启动新模型API。后续如统一冻结启动真实场，仍先封存RAW再揭示FULL，按原Gold逐字段核验；一般错误继续，安全／未知／技术错误硬停。未运行保留分母，不借旧场凑至少15窗。目标仍为假事实0、错人0、一般错误≤1、歧义不auto；默认生产放行表保持空。

只处理公开合成资料，不接业务库、真实联系人、桌面、微信或发送接口。

## 离线实施与验收

独立V模型及recorded wrapper、分阶段请求校验、records／owned／fixture第六版冻结均已接通。旧三档reference的固定配置及默认21窗合同与基线一致；Gold、提示、schema、A05理由编译器及生产空放行表未修改。

验证完成：923项提取单测通过（41.268秒），6个改动源码默认mypy通过，Spec／Standards独立审查均无剩余问题。随后仅补两项测试：嵌套JSON损坏保留digest-only／unknown且不重试；实际launcher→owned子进程→worker→Mock E200／V503，由父进程核对E／V实测请求、先领取后读合成key、2/32闭账、15窗未运行及进程／key退场。最终五个新增测试模块共16项定向验证通过；两项补强获独立增量复审无阻断。固定输出及Mock测试只验证工程合同，不作为模型语义验收。

本次没有真实API、真实凭据或业务数据读取，也没有桌面／微信操作。旧场A01一般错误、A05unknown及后11窗未运行仍保留；本票未达质量门。后续交主线集成及统一回归，再决定统一冻结，不从本离线提交直接启动新场。
