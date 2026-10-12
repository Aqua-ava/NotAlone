# 原始审核封存与有限基线执行接点（2026-10-12）

> 原票[指代07](../memory-extraction-accuracy/issues/07-reference-resolution.md)，基点`15334e81`。沿既有ECNU公开合成P1计划，新增功能冻结、OCR暂停。先以假凭据和Mock完成工具验证；未完成冻结前不读实际密钥、不启动供应商。

## 问题与方案

[225项工具结果](memory-structured-gold-result-20261012.md)已有固定JSON和逐字段计数，原回调却同时呈现E、V与程序结果，不能证明原核心spec要求的“raw先审封存再揭V”。新增受限的phased审核器，将视图、已保存回执及原判断不可改写绑定起来；语义仍由Agent显式填写，不设默认safe或自动中文判定。

## Implementation Decisions

1. `PhasedEvaluationAudit`接收独审固定reference、期望规范摘要、中文摘要、criteria文件摘要和两个显式审核回调；先调用公开21窗加载门，内部复制固定参考，不读取文件、密钥或连接模型。
2. 每窗先核实际case位置／名称／window摘要与reference，再从已保存adapter输出核原E。raw回调只收到当前window、该窗Gold／通用E判据、E原项及其索引／摘要；不含V、实际V输入、程序facts、原matcher或model response内部思考。
3. raw回调必须全量填写E14、meaning／inclusion／safety／classification／basis及逐命题raw证据组（raw_indices／variant_id／raw_meaning／coherence／branch／source／time）。只有pass/fail/unresolved，无默认值；不含未知的V／final映射。缺行、摘要／身份不合或非法值停；未决保留，后续不能升为通过。
4. shared loop向受限回调提供`persist_audit`能力，动作只在当前case阶段以既有semantic_audit事件保存给定JSON，返回已有私有record回执，不暴露预算／路径或任意kind接口。审核器须先保存raw封存载荷并核回执位置、payload摘要／原值、无脱敏缺口，才调用full回调。失败没有full视图和下一模型请求。
5. full回调收到原E→实际V输入→原V→程序层的完整packet与已封raw审核／事件摘要，只补后续lineage、V审核和去向判断；不能改raw字段、人物／含义／纳入、安全、分类、理由、原证据组及branch／source／time审核。score_case_review校验后，再保存完整审核与计数回执，才返回原ECNU四键决策。
6. actual ECNU路径必须使用该phased审核器，任意旧四键回调不作为真实执行准备；精确Mock继续允许旧协议以保留225项回归。无默认raw/full审核器，不自动P2，不改产品E/V/Flow、旧matcher或放行。
7. 四键决策预注册：明确原假事／错人／坏auto／歧义auto为safety_error；任一未决、对应缺口、结构／落盘失败停；完整审核确定的一般缺失／字段／去向／核验损失为general_error；只有必需完整覆盖、none控制及全输出检查满足才safe。optional缺失与正确重复单报，不因未提可选或重复多奖信用。旧matcher另报；任何结果quality_certified始终false。

## Testing Decisions

公开Seam为phased审核调用→受限persist回执→最终决策。以公开合成固定参考／允许工具payload验证：raw视图不揭V／程序、raw落盘失败不揭full、非法raw不落盘／不继续、full不能改封存语义、完整报告先存后决策、未决与坏auto停、真实路径旧回调先于凭据拒绝、Mock旧协议回归。TDD逐片red→green，最小类型检查和完整相关组、Standards／Spec双轴独审后本地提交。

## 最终冻结与执行条件

工具片全验后，固定唯一run与0700私有目录、明确aware截止、21窗／输入／Gold摘要、所需源码和实际依赖版本、ECNU端点及已有参数、42真实尝试封顶、停批和退场条件。核源码与任务专属提交对应，凭据只由明确运行时loader在持久batch领取后提供，不写入命令、文件或公开日志。仅现有公开合成材料可发ECNU；不上传真实聊天／私人原core窗口或使用其他供应商／工具fallback。

用户已有继续ECNU及连续验收授权，普通工具／冻结步骤不再问同一执行权限。缺实际凭据或需要原真实资料时只询问缺项，不把当前工具准备当新数据范围授权。P1完整且只有可复现一般错误才按既有计划考虑P2；运行失败、额度／期限、安全／保存问题不补位或换UUID继续跑。
