# 单V请求省略一键的有限兼容性探针

[新四难例实际结果](goal-memory-nullable-diagnostic4-result-20261013.md)在E200后再次遇到V500；标准schema离线合法，但服务失败原因仍未知。[ECNU官方参数和示例](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html)没有列出`tool_choice`，这是可检验的兼容性假设。E使用强制工具也已成功，不能据此直接认定该键不支持或造成500。本探针只提供一次技术观察，不是稳定因果对照，也不重开任何已关闭实验。

## 固定有限范围

单独新增**1次真实HTTP**，只请求V，不运行E、不生成新候选。固定台北**2026-10-13 23:45至2026-10-14 00:45**，UTC为10月13日15:45–16:45；最后HTTP起发严格早于**00:28:35**（UTC16:28:35）。300秒请求上限、重试0、单在途；985秒规划余量包含有界请求、600秒显式技术审核与收尾，不保证网络总墙钟。固定窗不顺延；准备、两轴、版本、冻结来源或时效不满足则不登记、不读密钥、不调用。

新增有限工程分配为`583=63已实际+183永闭未用+56未登记退役+280全140未启+本场新1`，本目标实际最多64次。这是Root工程分配，不表述为用户指定次数；目标开始前P1外账不并入，任一已关闭余额不复用。新UUID、nonce、绝对窗口和私有输出身份只在最终准入后由Root生成并原子封存，不自动安排后继。

## 单因素与来源绑定

重放已封存run`665225c9-ebcd-4d85-a8e8-0948e7e9163a`的A05 V provider_request，原规范请求SHA`49097d09f024d4b18bcb5166552eb5aede37f4c517b7c81cf080fd0145df172c`，schema SHA`ddb0ae8a244f2b7611a94dd1b8ba0f52ea2b2f12ff541134e7a43ed3bafaa0cd`。机器验证唯一差异是删除顶层`tool_choice`；`messages`、SYSTEM、user、候选／来源、`tools`／schema、`model=ecnu-max`、`temperature=0`、`thinking`和`stream=false`保持，`omitted_parameters=['tool_choice']`持久记录。没有Gold主张或人工答案进入请求，不修原输入、不删难例、不认定未名“她”为车主。

原21 Gold、标注与原A05公开窗口仅作端侧冻结和来源核对，不改字节。复用既有来源复核与nonce绑定审核桥，但此探针候选已看过，属于非盲性的技术协议审核；即使复用`full`封套标签，正式raw/full语义审核数也为0，不补签前场审核。

## 请求、记录与停止

既有`EvaluationBudget`／`EvaluationRecordStore`／`EvaluationTransport`负责单次持久预约、私有请求／安全响应记录和永久闭账。私有精确请求合同仅允许本探针的六键正文，不改产品原七键／强制工具合同或默认行为。所有执行依赖、实际版本、源输入／schema和当前提交blob先冻结，HTTP前再次核；旧目标12账和目标前另账逐个只读核closed／确切计数／非阻塞锁，不关闭或恢复别人的实验。

根`.env`既有ECNU三键仅由Root在新预算已领取、预约0且未到期后读取一次，不回显、提交或导出其他配置。外部追踪强制关闭；只用既有ECNU端点和公开合成材料。模型请求名与前场相同；响应报告别名须为前场E的`deepseek-v4-flash`才继续，别名仍不证明权重。

唯一响应须为安全可记录的成功JSON及同名V工具，严格验证V4、nullable proof DTO和同一个candidate／来源关系；普通content、缺工具／字段、不合法proof、非2xx、超时、别名变化、来源漂移、迟到或错nonce审核、记录／收尾失败均停，不fallback、不重试、不追加。没有有效proof时只记UNKNOWN，不能补产权或自动采纳。显式技术审核600秒内完成也不签任何原质量门；`quality_certified=false`、默认空表、原三门及AND门保持，业务迁移／旧回填／重采纳0。

只在实际单次响应、严格技术核对、及时显式技术审核和完整闭账收据均具备时才记技术完成。任何终态均保留HTTP、失败／unknown、闭账、PID与锁清理及证据；独立本地中文提交和公开历史检查完成后再报告。微信、OCR、App、Finder现场验收按用户选择暂缓，本探针不读取真实会话或发送消息。

## 实际终态与后继授权

唯一run5e292cb1实际HTTP200、40.72790824999902秒、CLOSED1/1，响应别名deepseek-flash触发本场预登记身份门停止，技术未完成／正式审核0。随后用户明确接受该别名并要求继续只用给定ECNU配置；[授权](goal-ecnu-model-authorization-20261014.md)适用于后继独立计划，本场保持原终态。详细[实际结果](goal-memory-nullable-V-tool-choice-probe-result-20261013.md)与总计64／183分账保留，不重开、不补签、不自动追加。
