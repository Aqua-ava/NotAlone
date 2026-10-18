# 任务07类型教学单项验证计划

首Pro16场已关闭：[实际结果](reference-pro16-result-20261018.md)为14窗safe8／一般6、A15 unknown／A16 unrun。A01、A03、A09、A10的E类型选择错误已由原Gold独审定位，本次只检验精炼类型映射和成对教学能否改善这些选择，不改变Gold、不称模型单变量优劣。

## 唯一语义干预

新封闭提取提示profile `reference-kind-teaching-v1`在原E2提示后增加现有kind到category／speech_act／assertion_status的映射，以及独立合成正负对例。按主断言、明确参与角色和阶段区分本人经历／第三人转述；否定本身不证明更正，出现“我”不证明接收已经发生，关系背景不把普通动作进度变成关系经历。新示例不是当前来源，不抄原16句子或命题答案。

默认E2及bounded教学提示不变；E2工具schema、编译器、V提示和四槽协议均不变。A05具体理由遗漏、A07 V时间误疑和其他V漏检是已知独立缺口，本次不声称会解决；A15未保存响应不能用于推测规则或构造答案。

## 封闭运行合同

- plan `reference16-pro-teaching-v1`；mode `deepseek_bounded_reference16_pro_teaching`；stage／kind／fixture档 `reference16-pro-teaching`。
- 复用provider `deepseek-pro-reference16-v1`，仅接受原plan和本新plan二项闭集。请求与响应精确为`deepseek-v4-pro`，E/V均disabled/none、named forced tools、显式8192、零重试。
- E为grounded-v2＋新教学profile；V为legacy-v4＋default。原`reference16-pro-v1`所有固定字段保持，不以新合同重释旧结果。
- 原21来源保真v2 Gold只选择A01–A16，16窗／18必需＋1可选，上限32次。D8仍不登记，旧bad_auto和缺失reason_rule保持。
- 新独立run、源码／提示／schema／版本／Gold哈希冻结，包含本计划；显式私有单键凭据只在领取后由loader读取。只处理公开合成资料，不接业务库／App／微信／发送接口。
- 沿既有300秒请求、600秒调用／审核、14380秒工作及14400秒外层期限；一般错误继续，安全错误、未知、技术失败立即停，未运行保留分母。成功关闭后不可补发或重开。

## 验证及解释

先验证新profile仅影响明确选择它的E请求，默认及其他profile字节、schema和编译结果不漂移；SDK／owned入口冻结字段必须匹配实际请求。独立Agent检查新教学语义与来源边界后再冻结运行。

实际验收逐窗RAW先审并持久封存，随后才揭示FULL的V及最终去向。全量审查输出，不用matcher或V supported签语义正确。主质量门仍为至少15窗、假事实0、错人0、一般错误≤1、歧义不auto；本次即使E标签改善，也不将未解决的V／理由错误豁免，不进行生产放行。

准备验证已完成：12项专用检查、33项相关回归、874项完整提取单测和7源码mypy通过。合并带来的旧审核fixture身份与异常类型期望已单例复现并独立修复。Spec发现教学可能把无关所有权缺失过度传播为未决，已限定为当前主张必需信息，增量复核通过；Standards／Spec剩余0。以上不证明模型质量，新场必须独立冻结并实际运行。
