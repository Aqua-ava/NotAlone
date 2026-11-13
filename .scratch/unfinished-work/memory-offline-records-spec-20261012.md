# 原07评测工具：私有记录与P0离线批次（2026-10-12）

实施基点 `336b05e9`；沿[原指代07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)及[准备方案](memory-quality-plan-20261012.md)补剩余离线工具，不新增产品功能，不恢复OCR。用户“继续使用”确认沿用ECNU；原真实模型预算未激活，人工Gold尚未完成，本轮仅使用公开合成资料与 `MockTransport`。

## 问题与解决方案

原预算与SDK接缝已经验收，但没有完整的允许请求／响应保存器、解析前原始适配器记录、全计划分母对账或批次完成收据。保存失败后仅有结果状态不足以审计；仅取E的第一个tool也会漏掉额外输出。

在既有HTTP发送接缝内加入评测专用记录适配器：持久请求先于发送，完整允许响应先于SDK／E/V消费，各次retry分别登记；离线driver复用公开 `evaluate_case/build_window/summarize`，只接假端点与精确MockTransport。两条SDK客户端都明确注入合成transport，关闭隐式LangSmith tracing、拒绝已有业务trace上下文。没有真实供应商执行入口。

## Implementation Decisions

- `EvaluationRecordStore`绑定原预算manifest的run、配置摘要、输出目录dev/ino和完整顺序表；事件种类、purpose与位置受控。文件0600、目录0700，目录FD核验，`O_EXCL|O_NOFOLLOW`拒绝覆盖／链接，文件及目录fsync成功才返回收据。
- 只存canonical redacted JSON及摘要、长度、脱敏版本／位置，不留原text/base64旁路，不读取headers。内部思考字段从结构及可解析tool arguments中去除；公开短理由保留，全部tool calls和额外字段在解析前保存。
- 非UTF8、非法外层JSON或不能安全处理的编码arguments只记录摘要／长度及正文缺失，立即停批。不得把这种缺口称为完整原文保存，也不能凭摘要审计具体语义。
- 传输异常只保存固定安全分类，不存exception正文或traceback；普通TransportError可按原SDK重试，每次消耗预算。保存或未知传输故障为BaseException硬停，不被SDK补发。
- 只读 `closed_receipt()`从原句柄核对持久closed状态与计数，不允许open恢复。driver退出 `budget.batch()`后才finalize；最终对账要求计划位置全部出现、预约序号及请求终态完整，未运行独列。保存故障不得返回已完成收据；文件可能部分或未知提交，不能凭文件存在代签fsync成功。
- 当前公共用例及既有期望不改。空E与失败／unknown分开，空E不执行V；首个假事／记错人、结构／运行／记录错误立即停止，剩余位置unrun。部分 `summarize`不代表完整轮次通过，Mock不认证质量或放行。

## Testing Decisions

已约定接缝保持评测工具内部，不影响整体产品架构：

| 接缝 | 证明内容 | 不证明内容 |
| --- | --- | --- |
| budget transport＋记录公开读取 | 请求先持久／响应先保存、retry序号、思考排除、落盘故障停发、输出身份及链接拒绝 | 供应商部署、真实资料或业务追踪 |
| `closed_receipt`＋`finalize` | 真正关闭、全计划／请求对账、完成收据与部分未知 | 物理介质回滚后的永久证据 |
| `run_offline_evaluation` | 实际SDK／E/V合成调用的完整P0生命周期、空／失败／额外工具、安全早停、unrun保留及隐式出站关闭 | 模型准确率、人工Gold、ECNU组合协议或生产factory整条装配 |

TDD逐片推进，记录真实red／green；最终运行完整相关组及AST检查，Standards／Spec双轴审查后自动作本任务中文本地提交。测试用自有临时HOME／输出，环境对象替换不复制现有秘密；禁止两套默认真实transport、socket与DNS。公开官网文档读取与模型请求分开统计。

## Out of Scope

真实模型执行／凭据读取、私人聊天或旧raw、App／微信／OCR、生产provider／trace／业务库、提示／schema／评分修正、Gold代签、维度放行、重复补跑、新留出、部署／push／PR均不进入本轮。真正ECNU执行driver还须在P0通过与人工Gold核定后按原票接线；本轮工具没有对应执行选项。
