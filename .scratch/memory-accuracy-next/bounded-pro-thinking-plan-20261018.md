# 有限运行依据：独立 Pro 双推理配置

## 证据与目的

e00279a0在原P01因E类别/期限错误、V supported且无issues触发potential bad_auto1；正式记录仍pending。现有E/V指令已明确完成阶段与时间边界，没有已证提示冲突。此方案不再据单窗加教学或改映射，而是在原任务路径检验显式推理配置是否影响完整核验。它不是已证修复，也不保证解决E分类错误。

2026-10-18核对[官方推理模式](https://api-docs.deepseek.com/guides/thinking_mode/)和[Chat Completions合同](https://api-docs.deepseek.com/api/create-chat-completion/)：thinking enabled及reasoning_effort=max可显式指定，推理支持工具调用；max_tokens为输出上限，length应视为截断。省略tool_choice与开启V推理共同构成本场配置变化，不称单变量因果实验。不能用temperature=0承诺确定性。

## 固定边界

- 新增独立闭集provider profile及请求合同版本；旧Flash、Pro Emax/Vnone和reference/core配置保持原合同。
- 官方deepseek-v4-pro，E与V均thinking enabled/reasoning_effort=max，两个实际HTTP payload均不含tool_choice，max_tokens仍8192。
- E保持bounded-dependency-teaching-v2，V保持当前nullable-proof-v3原提示/schema；来源守卫、compiler、proof producer和Gold不改。
- 正式导入/loader/指定任务/实际worker/recorded SDK/隔离PG/API路径不变；通过既有评测provider注入，不新增runner、迁移、任务字段或生产开关。
- 三键任务配置仍只保存模式与规则摘要；本配置由评测注册/冻结/实际请求/trace绑定，不宣称普通任务恢复会自动恢复该评测provider。
- 原15窗、7正控及原Gold，cap30、零重试、300秒请求限时、既有绝对截止；新目录/run/冻结。RAW先封存再FULL，任何安全/未知/非法输出仍硬停，旧场额度不复用。
- 缺工具输出、截断、无法安全记录、来源或合同漂移仍停止，不追加强制调用，不修模型输出，不从旧场拼分母。
- 所有七轴原质量门、真实依据交付及达标后的生命周期不变；生产放行表空，仅处理已授权合成隔离资料。

## 实施与核验

先接入已审core公共接线，再修改provider、ecnu、offline、records、owned及既有fixture的闭合分支。prepare零凭据/零预算；wrong profile、版本、阶段策略或重算摘要后的交叉错配须在凭据/HTTP前拒绝。

最高SDK测试核E/V实际请求及省略字段；真实worker+owned模拟链覆盖来源、freeze、记录和清理；旧Flash/Pro/reference/core控制保留。先最小负控红灯，再实现、相关回归、定向类型检查及独立Standards/Spec，提交后才冻结新真实场。8192可能被推理消耗，发生截断照实失败，不在运行中加预算。

当前仅方案冻结；没有启动新模型请求，未增加任何质量信用。


## 工程增量

独立profile为`deepseek-pro-bounded-thinking-v1`、请求合同version5，复用既有审核/任务/owned路径。新SDK和登记负控先因profile不支持转红；27项最小检查通过后，实际owned worker又捕获`evaluation_request_body_changed`：通用推理识别仅认Flash，Pro V默认仍发送named工具选择。修复只在bounded评测任务构造V时显式传冻结`force_tool_choice`，原for_mode保留该值，不修改生产识别函数。

该修复后单owned/登记20项通过，最终5模块组合59项/40.733秒通过，包含三种profile的实际owned路径和旧wire、新Pro length/content_filter原件与闭账、无工具/多工具单HTTP拒绝。Spec与Standards及force增量复核0问题。工程Mock不是模型质量；截至本记录没有新真实调用。

最终兼容检查：core/reference相关14项/3.094秒通过；新profile缺失/Flash/alias响应身份单例通过；6修改源码mypy明确成功，diff检查无空白错误。旧默认与提示/schema未改变。
