# 04 提取提示对齐腾讯 + 0.5 置信度兜底

Triage: ready-for-agent
State: open
Blocked by: —（真实小批 R2 与 03 错开执行）

按 spec.md 第 4 节实施。

- `backend-ts/src/memory/extraction/prompts.ts:10` 合同追加三条原则（宁缺毋滥、独立完整、归纳合并），措辞沿用腾讯骨架并适配主体/来源约束。
- `:149-150` `alternatives` 描述改为二分：同一句话有两种以上来源直接支持的不同读法、或指代身份无法唯一确定时才非空；细节未提到（对象、范围、原因没说）走「合并相邻句」，补不全不输出，不得用 `alternatives` 记录。
- `:81` `confidence` 描述追加：低价值或含糊零碎表达给低分（<0.5）。
- `complete-claim.ts:66` 与 `multimodal.ts:12,25` 字段清单只查不改。
- 提示变化改变策略指纹/版本：按 `test/extraction-policy-version.test.mjs` 约定更新版本。
- 用户已启用代码层兜底：`extraction/protocol.ts:138` 解析处加最低置信度阈值 0.5，低于阈值的候选记 `low_value_dropped` 执行事件后丢弃；丢弃不得使批次或水位判为未完成——实施前先读水位推进逻辑并写测试。

验证：`extraction-protocol.test.mjs`、`extraction-flow.test.mjs`、`extraction-policy-version.test.mjs`；新增结构断言（提示含新原则与 alternatives 二分）。真实效果验证归任务 06（R2）。

## Comments
