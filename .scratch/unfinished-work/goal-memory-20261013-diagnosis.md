# 持续目标：记忆质量技术诊断（2026-10-13）

## 范围与现状

本记录承接指代07、核心事实01、维度放行03及[最近P1结果](memory-p1-execution-result-20261013.md)。本轮解除OCR暂停由主Agent执行；此子任务处理公开合成材料及无秘密证据，不启动App、桌面或业务库，不读取真实聊天。旧实验全部关闭。用户答复允许模型调用后，主Agent限定新总包480次、本记忆片最多466次；另14次未启用。本片修复与回归时未读取根`.env`、未运行真实模型，真实HTTP累计0；首发仍待预注册、源码冻结与主Agent核验。

- 指代07：当前主集16＋语义补充3，原验收0/5。首P1技术失败，不能拿历史13/15作当前基线。
- 核心事实01：原验收4/5，历史真实必需严格覆盖6/12、可选2/6保持；公开两窗只有5个必需主张，不能替代真实同批与留出。
- 维度03：机制3/4，运行键只可推导subject/time/truth_intent；reference/paraphrase/reported/media缺字段，质量达标也不能自动放行。默认空表不改，逐类批准仍由用户决定。

最近真实P1：run `fa11f554-fc68-49ae-bad5-e13ae3b827fa`、第一次HTTP500、响应21字节、实际预约1/42、unknown1/unrun20、closed=true，余41关闭。原响应正文没有安全保存，不能据此证明具体500原因、凭据有效性或服务部署。正式completion收据缺失与预算关闭是分别存在的事实。

## 当前可执行切片与反馈接缝

只修复评测工具的终态元数据收口：HTTP错误的正文无法脱敏时，仍先保存摘要与缺口、硬停止后续发送；已持久关闭、完整计划与事件对账成功时，可以签发明确标为不完整且不认证质量的终态收据。读写、fsync、证据缺失或未知状态仍不能签发。不得保存原始不透明正文或内部思考，不恢复旧run。

接缝为公开`run_ecnu_evaluation()`（真实SDK＋精确Mock transport）和`EvaluationRecordStore.finalize()`（合成临时目录）。既有票与主Agent本轮认可此接缝；测试不通过私人方法或真实凭据。500供应商原因尚不能建立真实反馈回路，预算前不做原因修复；离线21字节不透明500只复现已知收口缺口，不声称重现供应商内部故障。

待验证假设：

1. 若收据缺失是记录器统一停止标记阻断终态写入，则保留同一不透明500响应及全部停发行为，只允许对账后的终态元数据写入应消除收据缺失。
2. 若是预算关闭或事件不完整导致收据缺失，则仅改变终态写入能力仍应失败；存储失败负控制不得得到收据。
3. 若未知客户端或SDK重试绕过停发，则相同500场景会产生第二次dispatch；完整入口测试必须仍只有1次。

## 新预算估算与顺序门

供主Agent集中分配的新包最多466真实HTTP：6个单变量技术探针（无SDK重试）＋21窗当前基线42＋必要反序复现42＋最多12个既有公开窗×2臂×2重复×至多2次E/V＝96＋全部140公开合成回归一轮280。重试消耗同一持久上限，失败、未知和未运行不删除分母，不为补齐追加预算。

这是最多一次候选的新授权总包，不能保证质量通过。A/B唯一候选和12窗名单必须由有效基线的实际失败决定并再冻结，未过门不启动后续阶段。真实核心验收另缺明确联系人、最小资料及用途/接收方范围，不能以这些合成数替代。缺字段迁移与逐类放行也独立保留。

## 证据与下一步

- 固定本片代码基点：`0ddc93175d8225243084de7e499cf776b4e5ee8e`。
- ECNU官方直开completions/thinking页面两次超时；Context7工具目录没有可用工具。官方搜索返回两日前抓取的[通用对话](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html)、[思考模式](https://developer.ecnu.edu.cn/vitepress/llm/thinking.html)与[模型介绍](https://developer.ecnu.edu.cn/vitepress/llm/model.html)内容，支持精确端点、thinking及tools；请求表没有tool_choice约定，故不能断定强制具名工具＋thinking组合已经被服务支持或就是500根因。思考页规定工具调用后的多轮才须回传reasoning_content；现有E/V是独立system＋user，不能据此添加思考原文或新工具循环。
- 下一步完成最终两轴复核、本片独立本地提交、新5个唯一run的额度索引与6个单变量技术探针冻结；主Agent确认冻结后才首次读取约定密钥和发送，不能恢复旧run或其余额。

## 验证记录

1. 公开`run_ecnu_evaluation`的新回归以合成21字节不透明HTTP500复现：`self.assertIsNotNone(result["receipt"])`红灯（实际None）；最小修复后同命令绿灯。完整入口仍只dispatch1、unknown1/unrun20、无语义审核、plan_complete=false/quality_certified=false，收据新增capture_gaps。
2. `EvaluationRecordStore.finalize`重复调用首次红灯：第二次因不可覆盖文件而抛evaluation_completion_unavailable。修复后每次复验完整闭账与事件，以原digest读同一0600文件；修改返回对象不改磁盘，磁盘内容篡改拒绝。禁止收口后的provider_request和dispatch、终态保存故障不能重试的2项负控制初次即绿，不虚构首次红。
3. 最小`tests.unit.memory_extraction.test_evaluation_records`＋`tests.integration.memory_extraction.test_evaluation_ecnu`共40/40通过，3.849秒。
4. 12个相关unit/integration模块共131项，失败0、错误0、skip1，8.518秒。包括records、http_budget、batch、provider_contract、phased_audit、reference、review、offline、ecnu、sdk_budget、wire_contract、accuracy_evaluation。Conda NotAlone、backend目录、disable-dotenv、无bytecode；外层清空继承环境，禁止HTTPX/HTTPX2公共及内部默认transport、socket connect/connect_ex和DNS。所有请求精确Mock，真实HTTP0。skip项保留，不能称131项全部实际执行。
5. 单源码`python -m mypy --no-incremental --cache-dir=/dev/null src/notalone/memory_extraction/evaluation_records.py`通过；差异空白检查通过。没有安装依赖或运行App/真实供应商/真实资料/业务库。
6. 提交前补一项真实红绿：任意非HTTP事件的合法payload=None导致新缺口汇总类型错误；非HTTP同名body_not_saved被误列为采集缺口。新公开store测试分别error/失败，限定provider_request/provider_response及字典payload后green；没有据此增加HTTP发送或保存正文。最小组增为41/41，3.175秒；同一外层守卫的12模块增为132项，失败0、错误0、skip1，8.653秒；单源码mypy再次通过。首40/131与此次41/132分开记录。

两轴：Standards由mac_provenance独立核查，硬违反0、Fowler判断0；Spec由ocr_repair独立核查，代码0项，指出本文验证记录滞后，补真实红绿及跳过边界后关闭。provider事件过滤与新负例的最终增量Standards0项、Spec0项。本片只提交3份评测代码/测试及本记录，不捎带并行OCR/同步/许可变更，不推送；提交由Git历史保存。不会将合成工具修复记为指代/核心/维度质量通过。
