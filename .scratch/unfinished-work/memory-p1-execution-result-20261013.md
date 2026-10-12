# 公开合成P1停止与收口结果（2026-10-13）

承接[完整运行规格](memory-p1-execution-spec-20261013.md)及[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)。用户明确指定根.env现有密钥，本轮已按该来源执行一次；没有重新录入、复制密钥或使用其他配置fallback。新增功能冻结、OCR暂停，真实核心6/12和默认空放行保持。

## 冻结与桥验证

唯一run `fa11f554-fc68-49ae-bad5-e13ae3b827fa`，基线提交`8aacc5957777ebe7de90f7f49fdb1b9d9db4003d`。59个源码／JSON／中文参考路径的工作字节均匹配提交blob；公开计划16主窗＋3补充＋2核心、28必需＋1可选。冻结文件SHA `4d6680176c3b175cc914bca9063cb4f44db2e1560d41e5eeb01f830b841f3e55`；期限台北2026-10-13 01:24:44.525001，最多42真实HTTP尝试。

JSON字节SHA `5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`、规范参考SHA `5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`、中文SHA `7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`分开；运行配置的gold_sha另为描述对象摘要，未混作文件摘要。Python3.12.13，openai3.3.1、langchain-core1.5.5、langchain-deepseek1.1.0、langchain-openai1.5.1、httpx0.28.1、httpx2 2.12.0、langsmith0.11.0、pydantic2.13.4。

仓库外一次性桥最终SHA `c37cbd9b7625e69f6afb7a9465907221ebd7c7837bcbf1d081ed5d0d71949461`，自检SHA `d4e7943dfe703b2d56131da22607a0583f74c76cc614929f20615e5c76c0cc54`；假.env／文件与等待helper **21／21通过**，AST2和单源码mypy通过，没有在这些检查中运行真实入口或加载真实密钥。初审发现case ID错误只接受A01–A21，遗漏B01/B02；补2项raw边界先red，再精确固定A01–A19＋B01/B02后green。随后同2项补验raw/full全部接受B01/B02、拒A20/A21，full补验初次即通过，未虚构red。最终Standards／Spec未解决发现均0项。Root另核两文件AST、0600权限／摘要、59源与提交及实际版本；没有重复既有242项工具回归。

## 实际执行与不能得出的结论

Root在Conda NotAlone执行一次仓库外run.py，显式disable-dotenv且桥在模型导入前清空继承环境。持久batch领取后，只从根.env精确NOTALONE_DEEPSEEK_API_KEY加载密钥；文件为当前用户所有普通0600文件，错误或stdout不回显值，没有写产品.env。固定ECNU ecnu-max、thinking enabled、temperature0、timeout60秒、SDK max_retries2，无工具／供应商fallback。

第一次提取请求收到 **HTTP500**。响应原始长度21字节，记录只能安全保存为`digest_only`／`redaction_unavailable`，未保留原文；不能据此断言500内部原因或凭据有效性。保存门按预注册要求硬停止，没有SDK补发、V或语义审核，没有拿到可用E对象或合法空E。真实尝试／持久预约均 **1／42**；受控进程session85241退出1，握手清理true。

完整21位置为：completed0、empty0、failed0、**unknown1、unrun20**。停止码ecnu_hard_stop；quality_certified=false。首窗未知不能算漏提、错误人物或通过，其他20窗不能剔除分母；没有任何模型准确率或覆盖成绩，原matcher／raw／accepted／full语义均未形成。P2未启动，失败P1不补位、不换UUID重开，剩余41关闭。

## 关闭证据与保存缺口

Root只读SQLite核对本run预约序列为1且端点精确符合允许表；state.manifest与启动manifest相同，state.closed=1，持久closed标记存在且普通0600／当前用户所有。请求与终态响应各1。3条允许事件（case_started／provider_request／provider_response）均可读取，records_error_code为null，两客户端cleanup_error_codes为空。

**最终completion收据不可用**，receipt_error_code=ecnu_completion_receipt_unavailable：响应不能安全保存的hard stop使record store停止，不能再写完成收据。本轮仅证明预算持久关闭、21位置及已存事件对账，不称整场完成收据通过。Root将无正文的单独对账存于本轮私有目录；它是补充证据，不能替代缺失的正式completion收据。

私有准备／输出目录0700，冻结、桥、允许事件和结果均0600；实际模型输入仅已有公开合成首窗，无真实聊天、私人实验窗口、内部思考或headers旁路。Root清理自检产生的自有bytecode及未使用的凭据向导，向导从未产生密钥副本；未消费握手0，无运行中的本轮进程。本轮App／微信／OCR／业务库／Worker／产品CLI操作均0。根.env只作为读取来源，后验元数据仍普通0600，不宣称核了秘密正文的前后字节。

## 原票与后续边界

原07继续claimed／needs-info，五条模型验收0/5；本次HTTP500不能提供当前16窗指代或核心公开两窗的基线。当前缺项为可安全解析的服务响应和完整模型证据，已不再是用户重新配置密钥。先保留技术失败、冻结与闭账证据；后续服务故障诊断及新有限批次须重新固定范围，不恢复本run或挪用其余额，不改Gold、prompt、原评分与默认放行。

最终公开结果／README／原票双轴复审：Standards0项、Spec0项未解决。Root提交前核本主题本地链接、原07完整历史prefix与5条未勾验收，59份已冻结源码／Gold运行后字节不变；账本203票、196resolved／7claimed／0open保持。仅提交本主题公开文档，不提交原始私有I/O或凭据，不推送。
