# 01 — DeepSeek 模型构造与可选冒烟

**What to build:** 开发者通过环境变量提供 DeepSeek 凭据后，系统可以构造真实模型并注入现有候选回复运行时，在显式开启的冒烟环境中用合成数据完成一次端到端真实生成，得到结构合法的候选或明确的失败结果；未提供凭据时构造即失败并给出可操作错误。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** None — can start immediately

- [x] 凭据与模型名只经环境变量读取，默认模型名定义为显式常量，可环境变量覆盖
- [x] 凭据缺失或为空时构造抛出明确错误，错误信息不回显凭据值
- [x] 构造支持调用超时默认值，慢速响应不会无限阻塞（默认 60 秒）
- [x] 构造出的模型注入现有运行时 adapter 后，既有 fake model 全量测试保持通过（零回归）
- [x] 新增凭据三路径（缺失/为空/合法）的单元测试
- [x] 新增 opt-in 冒烟：显式环境变量开启时以合成数据跑一次端到端真实生成，断言候选通过结构化校验或以既有运行时错误失败；默认跳过并在输出中明示
- [x] 冒烟与测试全程不读取 `chat_exports/` 私人资料
- [x] 冒烟实际运行（2026-08-23 通过：ECNU 网关 chat.ecnu.edu.cn/open/api/v1 + 模型 ecnu-max，端到端 24.3 秒）
- [x] 更新 README 如实记录当前能力边界

## Comments

- 2026-08-22 非冒烟部分完成。实现：`reply/adapters/deepseek_provider.py` + 7 个单元测试 + opt-in 冒烟用例（默认 SkipTest）。
- 官方文档核对：默认模型固定 `deepseek-chat`——DeepSeek 官方标注只有 V3 系列支持 tool calling 与结构化输出，reasoner 不支持；构造参数与超时行为经 `inspect.signature` 与实测核验。
- 2026-08-23 补充 base URL 支持：`NOTALONE_DEEPSEEK_BASE_URL` 环境变量与 `base_url` 参数（实测 `api_base` 传错名会被 ChatDeepSeek 静默忽略，已用测试锁死正确参数名）；单元测试增至 11 例。
- 2026-08-23 冒烟通过关单：实际供应商为 ECNU 网关（chat.ecnu.edu.cn/open/api/v1）模型 ecnu-max；真实调用一次通过结构化输出与全部确定性校验。首次冒烟发现并修复测试夹具缺陷：InMemoryReplyStore 硬编码只回传第一条候选，真实模型返回多条时触发持久化一致性校验；冒烟改用保留全部候选的 AllCandidatesReplyStore。
- 观察点记录：单次端到端耗时 24.3 秒（含生成与校验）；结构化输出遵循率首次 1/1。依赖锁定 `langchain-deepseek==1.1.0`；全量 182 例仅冒烟按凭据跳过或运行。
