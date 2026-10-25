# 完整提议语义范围修复

基点：`e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。本轮只用新合成材料和 localhost；工程通过不构成真实记忆质量通过。

## 已核验的缺口与修复

- 原 V payload 已有正文、subject、category、topic、时间与语用字段，却缺少场景、解释和备选含义等 E 字段。现代策略现在补齐 scene_name、alternatives、interpretation_reason、confidence、risk_flags、requires_all_sources、source_dependency_mode、timing，并显式携带空 event/conditions；正文和字段值不改写。
- 原 claim_check 只合取正文三类 facet，没有元数据的独立否决项。新 `claim_check.version=2` 要求 field_checks 分别覆盖 category、topic、scene_name、alternatives、interpretation_reason、valid_at、invalid_at、speech_act、assertion_status、figurative_type、event、conditions；任一未定或无支持均阻止接纳。
- 原 attribution 的 explicit 无实际提及位置。新 subject_mentions 把主体提及同时绑定到本项真实引文和当前候选段；位置按 Unicode 码点计算，来源引句须唯一定位。
- 第一／第二人称只在实际定位到相应人称形式后结合 sender 映射，不以 sender 单独推定省略主语。逐字保留的第三方主体或对象可用 literal_subject；这不是根据词典未命中推断名字。共同主体可列出多个提及或明确的复数形式。
- 原接纳绑定漏掉 `_scene_name`，核验后可替换场景仍签回执；现补入同次接纳绑定。
- 自审补齐 UUID 规范化，以及复数裁切、把人称标成第三方、重复短引句等定位拒绝面。

## 结构与语义分开

confidence、risk_flags、来源 ID、requires_all_sources、source_dependency_mode、timing 是配置、风险或来源定位信息；低分、风险标签和合法的 any + requires_all_sources=true 本身不判语义为假。原完整来源覆盖仍执行。

空数组和 null 不增添事实，语义字段的空值可用空 evidence_indices；非空语义字段的 supported 仍须有合法逐字证据。忠实保留未知日期可以 supported，不能将未知当无支持，也不能补造具体日期。

## 兼容与版本

- 保留 PreparedVerification 的公开 Interface：prepare 后只提供 request、fingerprint、selection、decode；没有新增模型、存储或全局状态入口。
- 默认、旧 null、旧 runtime v1 的 legacy-v4／nullable-proof-v3 请求保持原 payload、schema 和处理分支，不增加新字段，不重解释旧 proof 或 receipt。
- 只有显式现代策略使用 claim_check v2。v1 的现代模型响应不会补齐或升级，会在该项结构校验中失去接纳资格；同批合法邻项保留。
- 现代 schema、prompt、payload 均参加 request fingerprint。生产源码已在既有 source_stamp 传递依赖闭包中；既有 policy/window/cache 检查使旧现代任务或缓存不能当新合同使用，未迁移或重跑旧资料。
- verification_policy 仍是 complete-claim-v1，runtime 配置仍是既有 version=2；这次演进的是其嵌套 claim_check schema。源码身份变化负责区分实现版本，未改 SQL、HTTP、provider、ModelHost、账本或 legacy 合同。
- 已获明确授权，只适配 complete-claim-verification、complete-claim-production、extraction-flow-failure-contract 三个现有测试的现代响应夹具；旧分支和 60/61 业务断言保留。

## 证据与限制

红→绿日志包括：payload 字段缺失、未逐字段核验、无主体依据、验后换场景、UUID 误拒、主体定位不完整。每份 raw/public SHA 见 evidence-shas.json；原始日志仓库外 0700/0600，公开副本只替换本机路径。

最终相关模块为 56/56，TypeScript 与精确文件 diff 检查通过；运行入口见 manifest.json。未跑全量、实际 App 或微信，未调用真实模型；index、commit 与真实验收归主协调。

本模块只校验判断的合取、实际来源定位和绑定，不是通用中文句法或指代解析器。literal_subject 的语义角色、分类和解释是否真正受支持，仍依赖 V 的逐项判断；错误的逐项 supported 仍可能误判。人称提及仅支持合同列明的有限形式，其他表达不能因未命中而自动获准。上下文唯一性、所有者与语义主体的区别仍须独立语义审查；本轮不能声明真实未定提议已被解决或整体质量改善。
