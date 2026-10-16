# 显式 v4 受控未决理由补全

> 状态：离线实现与相关验证完成，待独立审查；审查前不提交。
> 日期：2026-10-16
> 上游：原21四槽真实场已关闭，结果见[封存记录](../grounded-evaluation/reference21-semantic4-result-20261016.md)。

## 问题与语义决定

原 A05 实际返回 `relationship_event`、`unresolved=false`、`ambiguity_codes=[]`、置信度 0.95，保留原引句但缺少所有者／指称未知说明，最终 auto，已封 FULL 判为 safety_error／contract_mismatch。本修复不改该标签或结论。零调用控制发现，即使显式给定 `object_ownership` 或再加 `entity_identity`，v4 也只在 alternatives 说明未知，interpretation_reason 仍是通用来源文案，遗漏模型已经明确标注的未决关系。

语义决定是将当前候选已有的封闭歧义说明同时呈现在简短理由中，便于用户连同正文、来源与 alternatives 复核。它解释候选保留了哪些未知，不认证未知关系的判定正确，不证明现实所有权或唯一人物身份。没有相应码就不生成相应说明；不根据“车”“借”“她”、case ID 或 Gold 选择／补足代码。原来的句首第三人结构 guard 保持；文案不把程序既有 guard 误称为模型选择。

## Implementation Decisions

仅修改既有 `compile_labels_v4` 共用编译路径中受 `version4` 限定的理由表达：保留原 interpretation_reason 前缀；有受控码时追加“当前未决说明：”及同一固定顺序的现有模板，不复制 alternatives 中的长引句／上下文。本文不新增受控码、模板语义、字段或 API。正文与完整来源仍在原 text、source_message_ids 及既有 alternatives 中；最长来源不得在理由中重复或截断。

编译后的实际成员并集沿既有逻辑处理；去重及顺序和 alternatives 相同，所有已有类别均可表达，不能只对 object_ownership 或 A05 特判。已完成问答的原理由前缀保留。固定模板总长受有限枚举约束，原单条 alternatives 8400 字符及整窗失败保持。

不改其他字段、置信度、风险、语用／自动采纳门、V、typed、生产默认或空放行表。不改 v2／v3 字节、模型提示／schema、原参考／Gold／matcher、旧 result 或任何 freeze 计划，不迁移或回填旧资料。源码改动后，旧 89 文件冻结仅作为已关闭历史证据，不再声称与当前工作树实时全匹配。

## Testing Decisions

接缝由上游明确指定为公开 `compile_labels_v4`；同一确定性候选再通过既有 `evaluate_case`／ExtractionFlow 观察模拟去向，V 只用合成固定支持输出，零模型调用、零真实预算、零业务存储。实际 A05 公开标签从封存 adapter 原件只读核对，持久回归只用同值合成字面夹具，不依赖 ignored 原件。

1. 修改前运行三控：原实际无码标签、显式 object_ownership、object_ownership＋entity_identity。记录原来的 auto／pending／pending，三者通用理由相同，正控理由缺口必须先 red。
2. 理由正控要求准确呈现所给未知类别和不从出借／接收推所有者；双码独立、顺序固定。无码负控保留原理由、全部字段及 auto；这保留原 A05 已封语义失败，不能用旧 matcher 的 passed 救分。
3. 给定码只允许理由发生新增表达；text／来源／其他 E14 与原 alternatives 保持。检查成员并集、完成短答理由、全码与长来源，以及既有 v2／v3 完整140字节回归。
4. 运行最小相关测试、grounded 相关回归与受影响源码类型检查。离线给定标签不证明真实模型会选择正确代码；不得宣称本场达标、typed 有效或业务自动采纳。

## Out of Scope

不重跑或重开原场，不新建真实预算、读取凭据或调用模型；不补产权／角色／身份、不认证 A05 正控已经满足完整人工语义 Gold；不实现通用中文指代或所有权解析，不增加 runner／harness，不变更 SDK 或依赖。
