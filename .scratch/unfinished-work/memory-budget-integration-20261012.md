# 记忆评测预算与最终请求接缝（2026-10-12）

本轮沿[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)完成可自主核查的评测工具前置，固定审查基点 `0e77254f`。依据[既有准备方案](memory-quality-plan-20261012.md)与[前次预检](memory-quality-preflight-20261012.md)，只处理 HTTPX 同步／异步发送、SDK 重试、批次领取和退场，以及合成 E/V 的最终请求表示；不接完整 runner、生产追踪或业务库。新增功能继续冻结，OCR继续暂停。

## 批次生命周期与未知故障

[预算模块](../../backend/src/notalone/memory_extraction/evaluation_http_budget.py)新增 `batch()`，首次发送前独占创建0600的 `claimed` 文件，完成文件与目录 fsync后才获得发送能力。领取凭证永不移除；`open()` 只承接尚未领取且零预约的准备运行，已领取、已关闭、已有预约或未知运行都拒绝恢复。同一运行不能靠换输出目录重新创建。

正常完成、上层结果保存异常和 `KeyboardInterrupt` 都关闭本批。关闭落盘再失败时保留原异常及安全关闭错误码；故障前的领取凭证仍拒绝其他句柄续开。普通 HTTPX `TransportError` 由原SDK按既定配置重试，每次仍预约且不退款；其他未知 transport 异常转成 `EvaluationBudgetAbort(BaseException)`，越过SDK的 `Exception` 捕获并停止本批。

为保留已有单 transport 接缝，未显式进入 `batch()` 的首发会自动领取；这只能保护发送和未知运行续开，不能捕获 transport 外部的保存异常。未来 runner 必须显式包住整批，并让保存异常逃出该上下文，不能捕获后继续下一例。

保证以文件和目录 fsync成功为条件，未认证物理介质损坏、外部删除或文件系统回滚。领取持久化本身失败时保证本次零发送、当前句柄停发；没有任何耐久证据时，不能声称物理层永久记住先前故障。

## SDK版本及兼容范围

实际安装为 OpenAI **3.3.1**、HTTPX **0.28.1**、HTTPX2 **2.12.0**。OpenAI 3默认使用HTTPX2，现有评测预算使用HTTPX；[该版本官方迁移说明](https://github.com/openai/openai-python/blob/v3.3.1/httpx2.md#temporary-escape-hatch-a-legacy-httpx-client)提供显式legacy HTTPX客户端注入，已在[SDK集成测试](../../backend/tests/integration/memory_extraction/test_evaluation_sdk_budget.py)通过同步／异步真实SDK的public调用验证。Context7当前无可用工具，采用官方版本文档及已安装源码核对；没有安装或修改依赖。

8项SDK测试覆盖503→200、连接失败／读取超时消耗封顶、400单次／503三次最终错误不退款，以及未知存储异常单次即停止。封顶的硬异常不会被SDK包装或补发；正常和异常退场后均拒绝重开。最后一次8项测试共有18次 `MockTransport` dispatch，真实HTTP及供应商模型调用均0；这不是HTTPX2原生transport或生产装配的验收。

## 最终E/V请求契约

生产[factory](../../backend/src/notalone/reply/adapters/deepseek_provider.py)默认temperature0、timeout60、SDK retry2；[产品提取装配](../../backend/src/notalone/memory_extraction/cli_support.py)显式thinking enabled，通用[评测入口](../../backend/src/notalone/memory_extraction/evaluation.py)只有显式 `--thinking` 才传该字段。默认值与安装版本均不证明当前供应商配置。

安装的 `ChatDeepSeek` 同时构造同步与异步SDK，但现有factory只接同步 `http_client`。合成契约测试须同时封闭两条客户端，不能只注入同步MockTransport就宣称没有可出站客户端。直接注入双客户端仅认证E/V适配器最终序列化，不认证factory整条装配或PostgreSQL运行。

实际服务／接收方、精确base URL、请求模型alias及允许的响应身份规则仍缺；历史ECNU记录不能自动替代。`reasoning_effort`、`response_format`、`strict`、`parallel_tool_calls`、`max_tokens` 按当前代码应记录为 omitted，不猜供应商默认。请求模型、原始响应模型与解析metadata必须分别保存；原始响应没有报告模型时记为缺失，不能用请求alias回填后冒充观测身份。

[最终请求合成测试](../../backend/tests/integration/memory_extraction/test_evaluation_wire_contract.py) **3／3通过**，包含metadata两个子场景，共4次Mock请求。真实E/V适配器验证具名 `MemoryExtractionOutput`／`SourceVerificationOutput`、关键schema与来源、target/context、thinking顶层、temperature0、stream false和上述字段省略；合成请求alias与响应报告模型不同，解析metadata及V内存台账保留后者。SDK会附带空token详情字段，首次断言遗漏后已按实际契约补齐，未修改产品行为。此处不认证未报告模型、实际服务路由或冻结漂移拦截。

## 验证记录

[批次故障测试](../../backend/tests/unit/memory_extraction/test_evaluation_batch.py)7项与[原预算测试](../../backend/tests/unit/memory_extraction/test_evaluation_http_budget.py)12项联合 **19／19通过**；SDK单组 **8／8通过**。两个实际red分别为批次接口缺失、未知存储异常仍是普通Exception，均逐片修复后green。新SDK接缝首次即绿，不虚构产品失败。原两条“发送后可重开”测试随安全合同改为拒绝重开，在原活动句柄内核对不退款。

测试仅使用自有临时HOME、0700输出目录、0600预算记录、明确假端点和假key。SDK集成守卫替换环境对象，不读取或复制当前凭据／tracing配置；禁止HTTPX和HTTPX2的公共及内部预绑定真实transport构造、socket连接及DNS。没有读取 `.env`、私人资料、业务库或历史raw，也没有启动App、微信、CLI、OCR或真实模型。

Conda `NotAlone`、`backend/` 中，以环境替换和两套网络构造／socket／DNS守卫运行完整相关组：上述30项，加evaluation、dimensions、adoption、flow、E/V adapters和来源核验，**146／146通过**，失败0、错误0。5个本主题Python文件AST解析通过，不生成编译产物。运行方式为 `PYTHONDONTWRITEBYTECODE=1 NOTALONE_DISABLE_DOTENV=1 python` 的内嵌标准库脚本，`unittest.defaultTestLoader.loadTestsFromNames` 加载对应11个模块；没有调用评测main或生产模型构造器。

固定基点 `0e77254fbadd5ff00249f9f90766d1fc41184fcc` 的9文件由独立Agent完成双轴只读审查：Standards硬违反／重要维护性问题／证据夸大均0，Spec新增缺失／范围越界／错误均0。审查未另跑App或模型；上述数字只表示受守卫的合成回归，不代表模型准确率或整场产品验收。

本主题4份Markdown的92条本地相对引用可达；原07完整历史前缀、全部5条验收及空放行台账与基点逐字一致，202票仍196 resolved／6 claimed／0 open。最初状态扫描漏识别普通与引用行格式，两次统计断言失败；修正为同时读取普通、加粗和引用行后完成全量核对，没有改写任何任务状态。`git diff --check`通过。仅清理新wire测试compileall产生的自有单文件缓存，其他产物不动；测试临时目录和环境patch均退场。

## 仍未开放的执行门

独立人工Gold仍缺，前次预检发现的转述auto、瞬时状态空时间及借用方向等分歧保留，未改expected或评分来凑通过。完整原始请求／允许的原始响应、错误与额外候选的可靠私有保存、思考字段排除、解析／评分结果、计划全量与失败／未运行对账，以及最终runner装配仍未实现。本轮只注入保存故障证明批次停发，不能据此宣称完整结果保存器已交付。

42／84仍为未激活的拟议新上限，不复用旧余额。07保持claimed／needs-info与原模型验收0/5；核心真实6/12、各维度门槛、[空放行台账](../../docs/memory-adoption-dimension-release-ledger.md)及六张未关闭原票保持。
