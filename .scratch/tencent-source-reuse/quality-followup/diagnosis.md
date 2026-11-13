# direct V 完整依赖核验缺口

## 观察与范围

- 根在固定 a61a2140 上完成两次真实 E/V；没有 B 或产品记忆写入。独立盲评的语义结论由根持有。
- 本会话只读了根提供的一份脱敏结构；未读原库、原文、身份映射、环境文件或相邻私有材料，未调用真实模型。
- P2：声明三个来源，V 引文仅覆盖两个；P3：声明一个来源，V 引文覆盖一个。两者 legacy-v4、proof=null，event/conditions 均 null。

## 可运行反馈

- `cd backend-ts && node --test test/extraction-verification-quality-regression.test.mjs`。
- 纯合成 E/V 公开调用链：依赖两条问答的确定主张只引一句含糊回答，当前仍进入 accepted，RED；两次重跑稳定。
- 同一探针保留明确单源事实和完整双源问答两个正向对照，当前均 GREEN。

## 已定位的合同边界

- 默认 runExtractionFlow 使用 legacy-v4；其核验无需结构化 proof，null 本身不是结构错误。
- validateSourceVerification 只检查引文来自候选所列消息、逐字出现、至少包含一个 target，没有检查候选声明的完整必要来源是否都被引用。
- requires_all_sources 与 source_dependency_mode 不是同义字段；本修复不把 any 改 all，不借语义检查改变持久删除依赖合同。
- event/conditions 为 null 时专项核验不适用；现有非 null 但未核实时会拒绝，没有证据指向“unknown 事件门漏放”。

## 排序假设与证伪信号

1. 完整来源覆盖未检查：只补少掉的来源引用，覆盖探针应恢复；缺引用被拒，两个明确对照仍通过。
2. V 对主体、对象和跨句含义没有可复验的结构证明：单源引文齐全也能出现错误 supported，不能靠覆盖修复宣称解决。
3. 事件缺省让正文中的新增时间关联不进入专项核验：仅凭脱敏形状不能证明原文语义，保留待独立验证，不能按关键词补 event。

## 最小修复边界

- 在当前 direct 的正式调用链启用完整依赖覆盖；只影响 supported 但遗漏候选声明来源的结果，保留原 model_verdict/model_issues。
- 核验输入明确 evidence 要逐条覆盖声明来源；结构、引用、追踪、预算与旧显式历史协议保持。
- P3 以及“所有 ID 和引文均齐全、但含义不成立”的情况保持未解决；覆盖只是必要条件，不是语义证明。
- 根已提交联合候选 ff45f2ec 并给出本切片写入时点；现仅修改 direct 流准入和显式 V 合同说明两个生产文件，单独冻结交根，不混入前一候选。

## 最小修复结果

- 当前 direct 在最终准入检查 supported 的引文 ID 集合覆盖全部声明来源；遗漏转 unsupported/insufficient_evidence，保留 model_verdict/model_issues 和完整原结果追踪。
- V 合同新增显式 require_complete_evidence 选项，仅 direct 调用开启；原 builder 默认、Python 对照及显式 nullable-proof-v3 保持。
- 未改 requires_all_sources/source_dependency_mode、event/condition、模型调用次数、来源集合或预算；没有私有资料写入。
- 根共享正向脱敏形状为单源 1/1、双源 2/2，覆盖检查均保留；错误形状 P2 为 3/2，应被该检查阻断。这里只核对 ID 形状，尚未在本会话重放真实正文。
- P3 为 1/1，覆盖完整仍可能语义错误；其单源语义问题明确未解决，不能宣称本问题级质量 improved 或可启用。
