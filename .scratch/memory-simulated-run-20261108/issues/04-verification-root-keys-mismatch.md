# 04 来源核验回复顶层字段不合规，整任务失败且不重试

Triage: needs-triage
State: open

## 现象
A 的第 6 批（共 6 批，每批约 20 条）在来源核验步骤失败：任务 `failed`，错误码 `extraction_model_validation_failed`，仅尝试 1 次，剩余 383 条保持待处理。前 5 批成功。

## 证据（提取追踪）
- 事件 `verification_validation_failure`：`classification=root_keys_mismatch`，工具 `SourceVerificationOutput`，参数可解析；顶层键为 `<other>` 与 `results`（5 行结果，verdict 4 supported / 1 uncertain）。
- 候选解析均为 accepted，内容本身没有被拒绝；失败原因是回复结构，而不是来源内容。
- 按规格整批协议异常保留阻碍，仅安全暂时故障有限重试，这里没有自动重试。

## 追加证据（第二次继续后）
- 同一信号共出现 2 次（第 6 批与最后一批，均 `request_fingerprint` + `results` 两个顶层键）；其余约 20 批核验通过。
- 复现点：`verification/diagnostics.ts:81` 要求顶层只有 `results`，而现行核验协议（`complete-claim.ts:216-217,281-285`）要求顶层同时回传 `request_fingerprint`。诊断分类对合规回复也会报 `root_keys_mismatch`，因此真正的校验失败原因被掩盖，未知。
- 回传的 `request_fingerprint` 与输入一致，`claim_check` 结构齐全；失败批次第 0 项都是 `uncertain`，但已通过的批次里也有 11 批含 `uncertain`，不能据此判断。
- 第二次点「继续」后，最后一批通过，提取全部完成（433/433）。

## 待查
- 复核：第 6 批开始于关闭总开关的同一秒（22:03:48），失败在 22:04:04；回复本身结构不合规，应与关开关无关，但需在开关保持开启的重跑中确认。
- 顶层多出的字段具体是什么、是否应容忍或在提示词/工具 schema 中明确。
- 同类结构错误是否应有限重试，避免单批拖垮整个联系人任务。
- 前 5 批成功后 memory/candidate 仍为 0：确认裁决阶段何时执行，以及是否因本次失败未执行。

## Comments
