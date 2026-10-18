# 任务07独立核验输出上限计划

[第六版实际结果](reference-v-thinking-result-20261018.md)仅完成原A01–A06：safe6／一般0、必需完整8/18；A07 V返回length、8192输出全部为reasoning、无工具结果。closed14/32、A07unknown、后9窗未运行，旧预算永久关闭。该直接证据支持调整独立V输出上限，不能回推更早摘要失败的原因，也不构成完整质量通过。

## 唯一干预与独立身份

保留E Pro disabled／none／forced、max_tokens8192；V仍为Pro enabled／max／省略tool_choice，只把V max_tokens改为32768。七次E输出仅87–145，未见E上限不足，因此不同时扩大E。V更大上限不保证工具交付、语义正确或不超时；不重试、不回退、不修补输出。

[官方Chat Completions合同](https://api-docs.deepseek.com/api/create-chat-completion/)允许max_tokens为1至393216，max推理未指定时默认128K。本计划显式32768仍低于该默认值，保留300秒请求及600秒阶段期限，不能把模型可接受的token上限当作时限内完成保证。

新provider为`deepseek-pro-reference16-v-token32k-v1`；plan为`reference16-pro-retention-v-token32k-v1`；mode为`deepseek_bounded_reference16_pro_retention_v_token32k`；stage／kind／fixture为`reference16-pro-retention-v-token32k`。整数request_contract_version为7，phase_request_version为`deepseek-reference16-v-token32k-v1`。

冻结phase_request_policy精确为：

```json
{
  "extraction": {"thinking_mode": "disabled", "reasoning_effort": "none", "tool_choice_mode": "forced", "max_tokens": 8192},
  "verification": {"thinking_mode": "enabled", "reasoning_effort": "max", "tool_choice_mode": "omitted", "max_tokens": 32768}
}
```

新档禁止全局max_tokens、thinking及reasoning_effort混入；阶段上限必须为真正整数，不能用float／bool等价代替。provider、plan、版本与phase policy严格绑定，重算摘要不能将错配变成合法。旧第六版global8192及原phase policy保持，旧reference／bounded／core身份与行为不变。

## 接线及离线验收

沿独立V模型与recorded wrapper；E、V模型构造、HTTP发送前expected校验、records登记、owned领取与fixture冻结均按各自阶段读取固定上限，不能把全局8192替换成32768。源码集合在第六版上仅增加本计划。E类型教学、V保真、A05有限理由、prompt／schema／Gold均不修改。

验证覆盖真实SDK请求E8192／V32768且V无tool_choice，float／bool／阶段对调／旧新provider-plan-version混配／全局max_tokens混入／来源漂移拒绝；length、响应身份错误、坏嵌套JSON继续硬停为unknown；缺工具／多工具沿旧门记failed，均不完整且零重试。实际launcher→owned子进程→worker→Mock用父进程检查实测请求、先领取后读合成key、闭账、未运行分母、进程退出与key删除，不能靠被异常捕获的HTTP回调断言证明通过。

旧profiles、固定配置和默认21窗合同与基线逐项保持，定向验证通过后才运行相关模块及有界全量。独立Spec／Standards审查后只提交本任务变更，交主线统一回归和冻结；本次授权仅离线实施，无新API。

## 实际验收边界

下一真实场如获统一冻结启动安排，必须全新run及冻结凭据范围；原A01–A16／18必需＋1可选／cap32／零重试、所有期限、RAW先封存再FULL、一般错误继续及安全／技术未知硬停保持。截断即unknown，缺工具／多工具沿旧门记failed，均停止而不补交付；不复用旧余额，不拼旧样本凑至少15窗。

仍须假事实0、错人0、一般错误≤1、歧义不auto。任务未通过AC、D8旧失败及reason_rule缺口、旧场记录和生产空放行表保留。只处理公开合成资料，不接业务库、真实联系人、桌面、微信或发送接口。

## 离线交付结果

第七版入口／SDK／records／owned／fixture已接通。新五模块15项定向验证通过，相关入口／SDK51项、records／owned37项及旧fixture13项均通过；实际子进程由父进程核对E8192、V32768及清理。全部936项提取单测通过（40.996秒），6源码默认mypy通过。旧所有profiles固定字典及默认21窗合同与本次基线完全一致。Spec发现的failed／unknown文案已修正并定点复审，Spec／Standards均0剩余；运行边界没有为文案而改变。

这些结果只证明离线接线与回归，不证明32768能解决实际截断或达到原质量门。本次无真实API，等待主线统一集成验收及冻结安排。
