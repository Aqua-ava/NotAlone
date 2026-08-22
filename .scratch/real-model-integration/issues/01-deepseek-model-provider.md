# 01 — DeepSeek 模型构造与可选冒烟

**What to build:** 开发者通过环境变量提供 DeepSeek 凭据后，系统可以构造真实模型并注入现有候选回复运行时，在显式开启的冒烟环境中用合成数据完成一次端到端真实生成，得到结构合法的候选或明确的失败结果；未提供凭据时构造即失败并给出可操作错误。

**Triage:** ready-for-agent
**State:** claimed（非冒烟验收已完成；冒烟用例已就绪，等 API key 到位后运行关单）
**Blocked by:** None — can start immediately

- [x] 凭据与模型名只经环境变量读取，默认模型名定义为显式常量，可环境变量覆盖
- [x] 凭据缺失或为空时构造抛出明确错误，错误信息不回显凭据值
- [x] 构造支持调用超时默认值，慢速响应不会无限阻塞（默认 60 秒）
- [x] 构造出的模型注入现有运行时 adapter 后，既有 fake model 全量测试保持通过（零回归）
- [x] 新增凭据三路径（缺失/为空/合法）的单元测试
- [x] 新增 opt-in 冒烟：显式环境变量开启时以合成数据跑一次端到端真实生成，断言候选通过结构化校验或以既有运行时错误失败；默认跳过并在输出中明示（凭据到位后运行）
- [x] 冒烟与测试全程不读取 `chat_exports/` 私人资料
- [ ] 冒烟实际运行（阻塞：等待 DeepSeek API key）
- [x] 更新 README 如实记录当前能力边界

## Comments

- 2026-08-22 非冒烟部分完成。实现：`reply/adapters/deepseek_provider.py` + 7 个单元测试 + opt-in 冒烟用例（默认 SkipTest）。
- 官方文档核对：默认模型固定 `deepseek-chat`——DeepSeek 官方标注只有 V3 系列支持 tool calling 与结构化输出，reasoner 不支持；构造参数与超时行为经 `inspect.signature` 与实测核验。
- 依赖锁定 `langchain-deepseek==1.1.0`；验证：单元 7 例绿，全量 182 例仅 1 个基线既有失败（memory validity window）。
- 剩余：凭据到位后运行冒烟（设 `NOTALONE_DEEPSEEK_API_KEY` 后 `python -m unittest discover -s tests -p "test_deepseek_smoke.py"`），通过即关单。
