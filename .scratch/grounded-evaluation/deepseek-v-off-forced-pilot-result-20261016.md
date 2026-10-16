# 单次V关闭思考／强制具名探针：失败并闭账

日期：2026-10-16。run `69b29dc6-7f37-4c1d-95ed-eb2a3226c052` 已closed **1／1**，零重试，自有worker及组已退出。本场没有可用verification、合法工具返回或质量通过；响应记录存在缺口，不能把缺失记录解释为已知HTTP状态或具体模型错误。

## 固定范围与实际执行

依据[原计划](deepseek-v-off-forced-pilot-plan-20261016.md)，基线`60c7f407`，独立`deepseek-v-off-forced-pilot-v1`，仅对新公开合成“我刚到家。”的给定v4标签编译候选调用一次V，没有E。保留原nullable-proof-v1提示与schema；实际记录请求为官方`https://api.deepseek.com/chat/completions`、`deepseek-flash`、thinking disabled／reasoning none／强制`SourceVerificationOutput`，无strict／beta或content补解析。

freeze字节SHA为`a628661a7c1f1f03d8f4cdf6c08a4a8f40de35c98e71ed5f2ff4c7ddab36c4b0`，实际82份源码／合同／本机helper及安装版本冻结。Root先核旧六场closed、新registry在授权绑定前不存在，再以run／freeze绑定授权唯一启动。单次HTTP读取30秒、完整调用60秒、工作70秒、原绝对外层80秒；本场未触发时限。

结果status为failed，stopped_code为`EvaluationBudgetAbort`，verification为空；worker耗时2.632秒、外层3.329秒，exit0、outer_timed_out=false。事件只有一份provider_request及一份provider_failure，后者记`unknown_transport_error`／`response_obtained=false`；没有持久化provider_response。

## 观测缺口及结论限制

冻结源码中`capture_response`进入时即置`responded=True`，后续响应转换／脱敏／摘要发生普通异常时，通用transport可另写固定`response_obtained=false`的failure。worker的failed分支与这一内存状态相容，故事件字段不足以证明“完全没取得响应”。这是本地记录缺口，不能与上一场的明确read_timeout等同。

对工具`arguments`字符串作脱敏时，非法JSON或非object可以触发该路径；其他保存前异常也可能产生相同观测。未保存的真实正文和状态无法事后还原；**不能断言真实HTTP200、返回了非法tool arguments、DeepSeek不支持强制工具，或关闭思考导致失败**。离线反例只能证明路径可达，不为本场补造响应。旧freeze、result和事件均原样保留。

已在Conda NotAlone、禁dotenv／socket的纯Mock诊断中运行3项测试，5个合成反例复现同样的两事件／无response／failed／closed1／1模式，其中HTTP503也可复现；真正read timeout对照仍是unknown。合法object但schema错误、外层非法JSON的对照会留下response事件。该诊断只证明缺失记录不能唯一归因，不读取旧未知请求或新增真实调用。诊断脚本保留在本机忽略产物中。

## 关闭后的只读复核

- freeze字节不变，82／82来源匹配，2个事件的payload规范摘要正确。
- SQLite以只读query_only核state唯一且closed=1，requests1／cap1，config摘要及收据匹配，closed标记存在。
- finish为closed=true、close_unknown=false、worker_gone=true；PID／PGID 70517均已不存在，cleanup_codes为空。Root只作存在性检查，没有向未知进程发信号。
- 本机忽略产物`desktop/artifacts/deepseek-v-off-forced-real-20261016-v1/`保留preflight／绑定授权／freeze／manifest／activation／2事件／result／finish及`root-closing-check.json`。后者为关闭后的核对时间点。

未读真实聊天、未写业务库、未操作GUI或外部发送；没有ECNU、远端Git或自动后继。cap1已永久关闭，不补发本场请求。原三张记忆票保持claimed、默认放行表为空；本探针不提供E能力、旧unknown修复、至少15窗、完整140、typed依据或维度放行信用。后继若修观测合同，须另立版本、计划、冻结与新台账。

封存报告的匿名运行元数据及观测结论经独立Standards／Spec审查均0项；纯Mock诊断由实施者另行复现，不代替真实响应。Root后继仅准备独立v2的观测修正，未在本场补写事件或启用剩余预算。
