# 任务07专用Pro16交付验收

此计划复用原A01–A16来源保真v2 Gold：16窗、18必需、1可选。原21参考的其余5窗不执行，也不补入分母；D8因reason_rule未定不注册到正式RAW/FULL，历史bad_auto和未运行记录仍保留。目标仍是假事实0、错人0、一般错误≤1、歧义不auto，不进行生产放行。

## 独立固定配置

- profile=`deepseek-pro-reference16-v1`，execution_plan=`reference16-pro-v1`；独立于bounded15与所有旧Flash身份。
- E=`grounded-v2`（现行成对教学提示），V=`legacy-v4`，两阶段均thinking disabled、reasoning_effort none、具名强制工具；温度0、零SDK/HTTP重试。
- 官方endpoint与请求/响应model精确固定为`deepseek-v4-pro`；每次显式max_tokens=8192。别名、多choice、length/content_filter、结构错误或无法安全记录均停，不修补响应、不切模型。
- 独立cap32，完整原顺序0–15；I/O300秒、调用/审核阶段600秒、工作14380秒、外层14400秒。未用额度永久关闭，不复用旧场预算。次数与输出token上限不冒充总费用硬上限。
- 复用现有records/provider/owned/fixture链及显式私有凭据helper。prepare只冻结路径，领取和绑定成功后才读取密钥；不继承环境中的模型或endpoint，不连接业务库或真实联系人。
- 原输入/时间/Gold/源码/提示/schema/依赖及计划冻结，逐请求核对实际SDK消息；更改或缺失即停止。专用入口只接受原21 Gold的前16个位置，不开放任意子集。

本场是当前组合的独立交付验证：相对最近Flash场变化包含模型与显式输出上限，审核装配也改用正式RAW→FULL；不声称模型单变量优劣，旧可见E/V审核不追认为盲审。原E2语义与Gold未变，不因新结果放宽答案。

## Agent审核及停止

独立Agent先根据来源和原Gold审核RAW十四字段、命题与额外输出；RAW回执持久封存后才开放FULL的V四字段和最终去向。V supported、旧matcher、JSON合法或工程单测不替代语义判定。结果可含一般错误并继续，安全错误/未知/技术失败立即停止，未运行保留分母。

逐窗回执须绑定run/phase/case/nonce/view摘要。末窗审核unknown也必须将outcome保留unknown，summary及最终receipt不得plan_complete。收尾核预算closed、进程退出、逐请求事件与全部16窗终态；资料审查与回执装配不算真实模型完成。

## 实现与离线证据

独立分支从稳定90af01c2实现七个共享接线文件与五个专用测试文件。provider和登记测试先红后绿；实际ChatDeepSeek/OpenAI SDK经MockTransport验证两阶段Pro/双none/forced/8192；owned子进程模拟503，先领取再读合成密钥、关闭预算并确认worker退出。旧profile固定字段和默认21窗提示/schema与基线全等。

最小模块通过后，相关95项及作者入口/owned115项通过；完整提取单测860项在34.035秒通过，六个改动模块定向mypy通过。独立Spec随后发现末窗unknown误算完成；修复前完整16窗模拟复现empty≠unknown，修复仅限Pro16，最终21项专用测试及offline定向mypy通过。首次测试夹具的目录类型、审核回执格式/枚举错误单列，不当作产品红灯。

Standards无实质问题；Spec发现1项并经增量复核关闭，剩余0。全量工程检查不证明真实模型质量；本文件写入时尚未领取新预算或调用Pro16。旧生产默认、阈值、Gold、失败与D8未完成状态均保持。
