# 评测私有记录与P0整场结果（2026-10-12）

本轮依据[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)与[受限实施规格](memory-offline-records-spec-20261012.md)，固定起点 `336b05e9`。用户答“继续使用”确认沿用ECNU；新增功能冻结、OCR暂停继续保持。此处只完成公开合成记录／P0协议，真实供应商调用0，不更新模型质量成绩。

## 本轮交付

- [记录适配器](../../backend/src/notalone/memory_extraction/evaluation_records.py)将run、配置摘要、计划、位置、E/V用途和预约序号绑定。请求先于发送、完整允许响应先于解析；只保存canonical redacted JSON及原字节摘要／长度，不读取headers，不留text/base64旁路。解析后的工具与原适配器消息也先保存再消费，额外工具不会被首工具解析遗漏。
- 文件0600、目录0700，目录FD校验预算原dev/ino，独占创建及文件／目录fsync；不覆盖已有事件或链接。事件正文和全部归属元数据回读都核验本句柄保存的摘要；含凭据字段的冻结配置拒绝落盘。
- 内部思考从结构和可解析编码arguments排除，保留公开短理由。无法安全处理的外层JSON／UTF8／编码arguments只存摘要、长度和明确缺口后停批；这些场景**没有原文语义审计能力**，不称完整raw。不保留异常正文／traceback，网络失败只记录固定分类。
- [预算](../../backend/src/notalone/memory_extraction/evaluation_http_budget.py)返回已持久预约序号，同步与异步路径每次retry各自保存请求和终态；`closed_receipt()`只核对原句柄已持久关闭，不恢复发送。完成对账要求所有计划位置、开始／结果证据和全部预约请求终态匹配，之后才返回完成收据。最终写入故障不返回收据，磁盘可能部分或未知提交，不能凭文件存在代签。
- [P0离线driver](../../backend/src/notalone/memory_extraction/evaluation_offline.py)只允许仓库现有公开合成用例、固定假端点／假key和精确MockTransport，明确双侧SDK注入。复用原E/V与评分，关闭隐式LangSmith tracing并拒绝已有业务trace；空E、失败、unknown、未运行分开，首个安全／结构／运行错误停批，部分汇总不算整场通过。该API没有ECNU或真实执行选项，不连接生产factory／业务库。

## 验证与实际红反馈

[记录测试](../../backend/tests/unit/memory_extraction/test_evaluation_records.py) **15／15**：保存顺序、思考／headers无旁路、全部工具保留、外层不可解析缺口、写入和两类fsync故障、响应保存后停发、软／硬链接、真正闭合／全分母、归属篡改、异步超时序号及凭据配置拒绝、双重编码／base64缺口、结果／输入／状态矛盾拒绝与完成收据同样脱敏。子场景均使用自有临时目录，故障文件保留至临时目录退场，不覆盖为成功。

[离线整场测试](../../backend/tests/integration/memory_extraction/test_evaluation_offline.py) **11／11**：空E跳过V、非空E/V、timeout重试封顶、假事／记错人早停、额外E工具保存后拒绝、合法漏提按原一般错误继续、输出目录替换、闭合失败、两客户端清理异常及隐式tracing关闭。该单组最终完整执行共19次Mock dispatch；供应商、真实socket／DNS均0。

主Agent最后一次完整相关验证 **172／172通过、失败0／错误0**：原146项相关组＋上述26项。Conda `NotAlone`、`backend/`，以 `PYTHONDONTWRITEBYTECODE=1 NOTALONE_DISABLE_DOTENV=1 python` 内嵌标准库脚本加载13个unit/integration模块；外层替换环境对象，仅保留显式disable-dotenv，禁止HTTPX／HTTPX2公共与 `_client` 默认transport构造、socket连接和DNS。5份本轮Python源码AST解析通过，不生成缓存。没有安装依赖或运行App。

实际red包括记录／driver模块缺失、思考原文仍留、关闭收据接口缺失、不可解析响应无缺口事件、timeout无终态记录、无结果却能签完成、归属元数据篡改未拒绝、凭据配置可落盘；均按公开接缝逐片修正后green。写入／fsync故障及部分扩展路径初次即绿，不伪造生产失败。

LangSmith关闭入口核对了安装0.11.0源码与[官方文档](https://docs.langchain.com/langsmith/trace-without-env-vars)；测试证明ambient开启时本场关闭、退场恢复。HTTPX/OpenAI既有临时legacy兼容边界保持，未认证HTTPX2原生或未来版本。

## ECNU与人工答案材料

[ECNU公开配置复核](ecnu-model-config-20261012.md)补齐既有精确base URL、POST端点与`ecnu-max`服务名称；官方资料记录其底模会升级，不能作为固定权重身份。沿原基线thinking enabled、effort省略、temperature0只代表发送值；实际档位、采样映射、强制具名工具组合及返回型号仍未实测，不能补成已知默认值。

[21窗人工审查包](memory-gold-review-packet-20261012.md)提供四组批量判据、六个重点输入和逐窗字段候选。A05第三人转述、A06瞬时时间与现行文档口径差异、A10/A15借用方向歧义、核心两窗的纳入／分类／拆合均未代签；全部21窗仍待人工核定，期望、提示、schema和评分未改。

公开ECNU笔记初稿在忽略的research目录，后移入本原票准备目录保存，没有强制加入被忽略文件。既有研究与旧模型实验不改写为当前事实。所有网站读取与Mock调用单列，未读 `.env`、环境密钥、私人窗口、旧raw或业务数据库；不启动App、微信、CLI或OCR。

## 仍未完成与收口

P0工具完成后，真实ECNU driver接线、完整请求／响应型号及漂移判据、全量独立人工Gold和真实质量实验仍待。42／84仍是未激活的新计划上限；旧预算不恢复，未补跑或放行。核心真实6/12、07原验收0/5、默认空放行表及六张未关闭原票保持；真实来信／双联系人和WCDB精确构建／二进制许可等Mac缺项不由本轮代签。

首次相关168项通过后，双轴初审分别发现Standards3项、Spec2项：完成收据脱敏旁路、配置凭据白名单、双客户端清理异常、双重编码arguments及结果／输入／状态对账不足。已修正；新红反馈包括双编码仍留、password／access_token／未知配置与URLuserinfo可落盘、失败升级／输入／结果更改仍能签收、关闭异常跳过另一侧。完成收据脱敏另补回归，首次即绿，不伪造red。最终相关172项通过；独立复审Standards硬违反／重要问题／证据夸大全0，Spec新增问题0，初审五项全部收束，不推送。

本主题6份Markdown的103条本地相对引用可达；原07完整历史前缀和五条验收与基点不变，提示／公开用例／评分／空放行台账逐字一致，202票仍196 resolved／6 claimed／0 open。测试临时目录、环境与tracing上下文退场，自有App／CLI启动0。过程中曾出现本主题之外的未暂存桌面体验测试文件，本轮未读取／修改或提交。
