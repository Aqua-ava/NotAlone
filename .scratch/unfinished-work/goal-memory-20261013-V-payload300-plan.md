# 持续目标：当前失败V载荷的两次300秒技术诊断预注册

[180/0新基线](goal-memory-20261013-baseline-after-timeout-result.md)仍在首窗V读超时，当前没有有效语义基线。本探针只定位**同一个实际失败V请求**的技术可用性，不重开基线，不修改E、Gold、thinking、供应商、门槛或生产默认放行表，不自动启动任何后继阶段。

## 唯一范围与有限配额

新run `5363d8e3-3353-46d7-ae4b-4d1af63bf20e`，真实HTTP硬上限**2**。Root从尚未启用的11预留中明确分出2，剩余**9未启用**；此前四个run均已durable closed，实际累计13，旧基线38、旧V2、新基线40全部永久关闭。新的`goal-budget-amendment-v2.json`只新增这一用途，引用原466索引与已冻结amendment-v1，冻结466＋已闭首V3＋新V2＋未启用9＝480。原所有计划、计数、失败和未运行保留；无余额复用、UUID补位或自动后继。

台北时间固定2026-10-13 **03:10–03:22**，UTC前日19:10–19:22，共12分钟，不滚动延长。每HTTP起发须早于**03:16:15**，留300秒读限＋45秒收尾余量；到边界在预约前拒绝。开始前、源码或版本漂移、注册目录已存在（包括未领取）、收尾或计数未知均拒绝发送/成功签名。新run在Root最终hash核验前不注册或发送。

固定载荷取自新基线唯一V实际请求，规范SHA`d54e5ca3b861edc035d6d9322983e1f1ae7a21298a5fc6712ef803546372e30f`；原正文已保存thinking enabled，不补、删或改任何业务字段。两步共用此载荷、公开A01窗口和新E候选，不使用旧`1ed50f65…`载荷替代。来源由closed2/42完成收据、provider_request及read_timeout事件、E-only片段共同绑定。该E两命题raw2/2而完整契约0/2，V技术成功也不能为speech_act或理由救分。

1. D01：现有LangChainSourceVerificationRuntime＋ChatDeepSeek SDK，read300，connect/write/pool10，max_retries0，底层transport retries0。
2. **仅当D01恰一次发送和恰一个terminal read_timeout，且阶段/期限/冻结仍通过**，D02直接HTTPX read300/其余10、retries0，发完全同一body。SDK合法返回、其他异常/HTTP错误/工具结构或来源证据非法/opaque脱敏故障均停止；不能为了凑两次继续。

任一合法SourceVerificationOutput＋来源/逐字证据契约成立即停止并将后续位置保留unrun；两个读超时则停止。两步分别有340秒墙钟alarm，始终还原SIGALRM；墙钟alarm的generic timeout不属于准许续发的read_timeout。03:22观察截止另行复核，客户端/预算/events/收据不可核不签成功。合法工具格式及来源quote只证明技术路径，语义质量始终false。

唯一服务仍ECNU endpoint/request_model=ecnu-max、temperature0、stream=false、thinking enabled、具名V工具、fallback=false；服务响应alias另记，不认证权重身份。密钥只在持久batch领取后用既有loader读取根.env三个ECNU键，不回显或保存headers/思考。仅本次公开合成资料，没有私人聊天或App操作。

## 冻结与最小验证

- 外部根`/private/tmp/notalone-memory-goal-20261013-ac04d687/`0700；`v_payload300_diagnostic.py`、`v_payload300_selftest.py`、`v-payload300-fixed.json`、`goal-budget-amendment-v2.json`、`v-payload300-plan-v1.json`及测试/准备记录均0600。未来唯一输出`v-payload300-diagnostic/`0700，不覆盖旧桥/计划或数据。
- runner SHA`69c6068a3e9957e700d84be6502e7a3f2add92646d5434e0b6580c575eddd010`；bundle规范SHA`4f48334ec3ab71592e0390d6a201b4463a2e5d967f8918a223f2c767800fe70b`；amendment-v2规范SHA`7e307c30880b42e8a6e25f66e9473d6b23308be01f613388ab6ed2842f5757c6`；自检SHA`a5ffc2c27f649e90ee856fdca6a0ccc0582fe593681c79d2d11b9950b2c62ae9`。
- 源码commit`6faaa6badce3e0ed6017291e5f55ee06338ef09a`，60必要源/Git blob与工作字节一致，包括52d参数、d488日期修复及原公开Gold。新server错误映射及桌面验收fixture不在这些60源中，不据此豁免实际发送前的60源字节检查。
- 8依赖冻结仍为openai3.3.1、langchain-core1.5.5、langchain-deepseek1.1.0、langchain-openai1.5.1、httpx0.28.1、httpx2 2.12.0、langsmith0.11.0、pydantic2.13.4。四个closed收据实核6/6、4/42、1/3、2/42，SHA一并入bundle；不以原unrun索引快照代替当前真实终态。
- 精确Mock首16方法全绿0.618秒，没有伪造red；增响应后/终态deadline复核和request/alias分列后16/16、0.703秒，mypy通过。覆盖首合法停/条件unrun、SDK300一次read_timeout才HTTPX300且body逐字规范同d54、双读超时不重试、JSON/opaque500/非法quote/非read-timeout立即停、cleanup/store/closed不可核、alarm恢复、开始前及345秒边界拒绝先于注册/secret/dispatch、同ID旧目录拒绝、闭40余额/自动后继一致重算摘要仍拒绝。新要求的测试首次即绿，原V桥负控红绿保留在历史记录，不借此声明本轮新red。
- 守卫禁止默认HTTPX/HTTPX2 transport及socket/DNS；精确Mock的临时home/预算随测试清理，真实HTTP0。摘要Mock的真实HTTP上界固定0；真实闭账未知预约/响应数为null，main失败1。尚未创建新run的真实注册目录或加载真实credential。

现有两位Agent独立Standards和Spec最终均0项；实核5个关键SHA、60源/blob、四个closed收据与新注册缺席，不运行桥/测试/HTTP/App或读取密钥。Spec指出结果文档将raw证据283e误称完整视图，已纠正为完整视图6e30；冻结bundle原来即绑定正确6e30，桥及所有载荷无改动。Standards另对E-only片段独立同意12字段通过、speech/reason两项失败，不签正式audit或质量。

待Root最后hash/源码/闭账配额/注册缺席/时间核验后再唯一启动。本片准备新增真实HTTP**0**；当前目标真实HTTP累计**13**，有效基线**0**。
