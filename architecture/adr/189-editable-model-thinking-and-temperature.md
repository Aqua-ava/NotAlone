# ADR-189：分别手动配置回复与记忆的模型参数

状态：已接受并实现，2026-11-14 用户要求可手动配置。

## 决定与适用范围

在「设置 → AI 服务」提供回复生成、记忆处理两组独立参数。各组可选择关闭思考或 `low`／`high`／`max`，温度可填 0–2 的有限数字；已有配置缺少这些字段时继续使用关闭思考、温度 0。记忆组覆盖提取、来源核验、裁决与合并、L2 场景和 L3 画像整理，不新增逐阶段设置。

本决定局部替代 [ADR-026](026-pragmatic-interpretation-before-memory-adoption.md) 的温度固定 0 条款，扩展 [ADR-062](062-official-deepseek-reply-input-budget.md) 中非实验场景的思考配置入口；默认值、完整请求预算、来源核验及数据边界保留。`strict` 核验合同与普通候选的输出解析不因参数设置而切换。

参数沿既有受控模型配置文件原子保存，不重填密钥，不改变模型、接收方或联系人范围；启动环境覆盖时明确拒绝。保存后沿现有配置重载流程排空已接纳调用、重启并核对生效，失败保留待加载状态。保存本身不调用外部模型，不重写既有记忆和历史请求。

## DSH 与官方接口依据

继续复用唯一的 DSH provider、模型宿主与许可服务。两组参数进入各自的模型 binding 和配置指纹，每次调用显式传入；若任一用途启用思考，共享 provider 使用允许思考的连接策略，关闭思考的用途仍显式传 `off`。不得为两组参数另造 provider、Agent loop 或修改 DSH 核心。

核对声明、锁定与安装的 DSH／DeepSeek adapter 为 `0.2.1-rc.2`、Cordis 为 `4.0.5`；相邻 DSH HEAD 为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，查证固定基线而不切换工作树。已安装公开类型 `lib/types/config.d.ts` 说明 `thinking:disabled` 会限制所有调用为 `off`；对应固定源码 [serialize.ts:147](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/serialize.ts#L147) 优先取调用的 `reasoningEffort`，校验连接策略并序列化 `thinking`／`output_config.effort` 与 `temperature`。安装制品 `lib/index.js:1707` 行为一致，未做整个制品的可复现构建比对。

[DeepSeek 思考文档](https://api-docs.deepseek.com/guides/thinking_mode/)与 [Messages 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/#simple-fields)确认三个思考档位及温度 0–2；温度仅非思考模式生效，思考时用户温度被忽略。界面保留温度值供关闭思考后使用，启用思考时禁用该输入并就地说明。

## 验证边界

验证覆盖参数校验、两组隔离、受控持久化与环境覆盖、重载失败和恢复，以及官方 adapter 实际序列化参数。桌面检查控件、编辑草稿、保存反馈和重新加载后的回显。合成供应商用于验证传输合同，不能证明调整思考或温度后的真实回复／记忆质量。

在后台与桌面分别执行 `node --test --test-concurrency=4` 的相关模块，后台八模块三十九项、桌面七模块六十八项全部通过；根目录 `pnpm run typecheck` 与 `git diff --check` 通过。实际开发 App 验证记忆高档选择时温度禁用、撤销编辑、回复温度 0.25 保存与重载回显，再保存还原关闭思考／温度 0；调用台账未增加，未发送外部聊天或调用真实模型。独立审查发现的对象键顺序误判已通过逐字段比较和红绿回归修复，复审关闭。

桌面测试清单总校验另被既有提交 `e656c071f` 中已跟踪但未登记的 `assistant-session-recovery.test.mjs` 阻断；本任务的两份新测试已登记，不改动该其他任务文件，不能据相关测试通过宣称总清单通过。
