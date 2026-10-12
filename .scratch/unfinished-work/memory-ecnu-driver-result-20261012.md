# ECNU评测接线与发送前门结果（2026-10-12）

本片承接[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)与[受限实施规格](memory-ecnu-driver-spec-20261012.md)，基点`bf400c99`。用户已答A14不存成关系资料；21窗保留，只有该纳入取舍属于用户确认，其余是Agent技术参考与独审。新增功能冻结、OCR暂停，真实供应商／模型HTTP、真实密钥、业务库、App／微信／OCR操作均0。

## 已交付的工具

- [发送前contract](../../backend/src/notalone/memory_extraction/evaluation_provider_contract.py)固定精确ECNU端点、7键请求、E/V具名工具，绑定不可变期望；构造与每次发送核对aware截止、显式源码摘要及普通文件范围。到期、未绑定、body／源码漂移、路径逃逸／链接或隐藏资料都停发。
- [同步／异步transport](../../backend/src/notalone/memory_extraction/evaluation_http_budget.py)共享同一预算和contract；请求门先于预约／保存／发送，允许响应先私有保存，再核成功Completion的原model字符串或缺失观测。错误响应计数但不建立基准；后续成功字段变化停发，不断言底层权重变化。
- [ECNU入口](../../backend/src/notalone/memory_extraction/evaluation_ecnu.py)固定16＋3＋2公开窗、P1最多42次尝试，无默认凭据／供应商／工具fallback、不自动P2。Gold／源码／期限与私有目录准备成功，batch持久领取后才一次加载显式凭据；loader失败整计划unrun，关闭故障也不能重开原run。两只SDK客户端明确注入同一预算，不用业务factory。
- [共享批次协议](../../backend/src/notalone/memory_extraction/evaluation_offline.py)复用P0记录、原E/V、原matcher、完整位置状态及双客户端收尾，P0公开行为保持。解析前保存允许原适配器输出，再验证E14字段原JSON类型／枚举／nullable／数组，不以类型转换接受布尔或字符串置信度。冻结的内存prompt／schema被改动也停下一发。
- [固定记录扩展](../../backend/src/notalone/memory_extraction/evaluation_records.py)只加真实入口所需9个配置字段和`semantic_audit`事件。每个完成位置要求独审回调，绑定位置／判据摘要、固定决策和原因码，先保存再继续；无默认safe，安全／未知／非法审计停批。原matcher与独审分报，结果仍`quality_certified=False`，不自动放行。

## 验证

[contract单组](../../backend/tests/unit/memory_extraction/test_evaluation_provider_contract.py)15／15，连原budget12和records15为42／42。覆盖过期／未绑定／body／源码／路径／JSON键／参数与具名工具、先存响应再停、SDK429→200实际离线重试、缺失字段、同步异步共门。

[ECNU整场单组](../../backend/tests/integration/memory_extraction/test_evaluation_ecnu.py)16／16；连P0原11、wire3为30／30。该最终ECNU单组共98次Mock dispatch；包含21窗、独审与旧matcher差异、独审位置篡改／未知／安全早停、42封顶SDK重试、loader前冻结／权限／唯一run、close故障不可续开，以及内存schema／prompt漂移和原JSON类型拒绝。

主Agent最后完整相关组 **203／203通过**（旧172＋contract15＋ECNU16），unittest 6.460秒、工具总9秒内。Conda `NotAlone`、`backend/`，运行本轮自有临时标准库回归脚本，`unittest.defaultTestLoader.loadTestsFromNames`加载15个unit/integration模块；替换环境只留disable-dotenv，外层禁止HTTPX／HTTPX2公共与`_client`默认transport构造、socket connect/connect_ex和DNS。没有运行真实评测main、产品factory或私有资料。

5份源码 `python -m mypy --no-incremental --cache-dir=/dev/null` 无问题；7份新／改Python的标准库AST解析、差异空白检查通过，不生成字节码。没有安装或修改依赖。

实际red→green包含模块／未冻结入口缺失、未绑定与body／source／路径／身份门、独审篡改位置、坏目录先读key、loader失败未闭合、close故障可续开、漏冻memory初始化依赖、内存prompt／schema变化仍继续，以及true／字符串confidence仍发V。最后两项原分别继续21次、或1E＋1V＋下一E，现首例保留后下一发送0、或只有1E且V0。既有及初次即绿检查不虚构red。首次类型检查还发现records原有6项、P0旧代理3项注解问题，已最小修正`NoReturn`／`Any`／`SecretStr`与模型类型边界，无产品行为改变。

## 参数证据与答案边界

Context7工具不可用，沿官方[工具转换](https://reference.langchain.com/python/langchain-core/utils/function_calling/convert_to_openai_tool)、[具名绑定](https://reference.langchain.com/python/langchain-openai/chat_models/base/BaseChatOpenAI/bind_tools)、[OpenAI3.3.1临时legacy客户端](https://github.com/openai/openai-python/blob/v3.3.1/httpx2.md#temporary-escape-hatch-a-legacy-httpx-client)和[HTTPX transport](https://www.python-httpx.org/advanced/transports/)核对，再与实际安装版本及Mock最终序列化确认。官方最新Core页面不是安装版本证明；实际Core1.5.5、DeepSeek1.1.0、LangChain OpenAI1.5.1、OpenAI3.3.1、HTTPX0.28.1／HTTPX2 2.12.0。没有改用strict、effort或原生HTTPX2，Mock不能证明ECNU强制具名工具＋thinking组合实时可用。

[技术参考](memory-gold-agent-annotations-20261012.md)补E14字段、28必需＋A15可选1、有限topic、风险／alternatives／短理由及V四键／证据。独立Agent复审纠正A03只reported、分类收紧、方向歧义必须在alternatives保留及“家里”措辞；无需用户再挑标签。它仍不是已装配结构化Gold／逐字段评分器，最终来源／参考摘要冻结与真实基线未执行。工具只校验调用方提供的准备协议，不能自认证语义Gold正确。

## 当前结果与下一入口

本片工具交付不勾原07的模型验收，不改变真实核心6／12、默认空放行表或六张未关闭原票。42／84仍未激活，旧预算关闭；未把runtime源码文件摘要冒称Git提交绑定，也没有用Model字段认证权重版本。下一片先完成结构化参考／逐字段审核对账与完整运行冻结，再执行有限模型基线；真实来信／双联系人、WCDB来源与OCR等Mac缺项继续保留。

代码及最终元数据双轴复审：Standards0项、Spec0项未解决发现。增量Standards曾发现1项旧待复核清单未标历史状态，已修正并复审关闭；代码两轴未发现问题。只有本任务文件将按工程规则创建本地提交，不推送。

本主题7份Markdown的177处本地链接目标可达，21窗／28必需＋1可选及历史前缀／5条AC静态核对通过。原生产prompt／schema／parser／公开case／原matcher／空放行台账与基点不变。并行提交新增真实ECNU回复估算预算01，当前共203票、196 resolved／7 claimed／0 open；本片只读其标题／角色／状态以同步总览，不领取或改变该票，原六张未关闭任务保持。暂存与提交排除并行未跟踪的桌面实体验证文件，没有读取其正文或任何真实运行输出。

提交后补记：新文件暂存检查发现contract末尾多一空行，首次提交未据此停下；已删除该空行，并对包含新文件的实际提交差异重新运行空白检查。此补正只有文本格式，不改变代码行为或重报新的203项运行。
