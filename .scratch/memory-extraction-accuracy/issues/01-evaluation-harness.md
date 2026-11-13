# 01 — 评测骨架与现有用例迁入

**What to build:** 一个仓库内可重复运行的记忆提取准确率评测入口。用例用合成数据描述：发送者、目标/上下文消息、期望最终去向（自动采纳 / 待确认 / 不生成），可选期望主体。工具完全复用正式提取链路（窗口 → 结构化候选 → 外壳校验 → 语用分流），不复制提示词或分流逻辑；不连接数据库、不写入记忆；无凭据时明确跳过且不发起网络请求，显式凭据才调用真实模型；输出逐条模型字段、最终去向与期望对比，以及失败汇总。现有 24 条对分用例迁入新格式并按维度归类。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无，可立即开始

- [x] 无凭据运行时明确跳过，不读取真实数据、不发起网络请求
- [x] 有凭据运行时逐条输出标签、去向与期望对比及汇总
- [x] 评测复用正式链路组件，不重复实现提示词、校验或分流
- [x] 现有 24 条用例迁入并标注所属维度
- [x] 不连接数据库、不写入记忆、不打印真实私人内容

## Answer

已建立 `notalone.memory_extraction.evaluation` 及 CLI 入口、24 条分维度合成用例和默认跳过的独立真实模型冒烟。提取、字段/证据校验、语用分流及共享置信度/风险门槛复用正式实现；不写入存储。专用评测凭据隔离于日常运行凭据，默认不读取 `.env`。主体检查拒绝混入错误主体，贷款申请增加 assertion/asserted 标签检查。

验证（均在 `conda activate NotAlone` 后）：

- TDD 首个风险事实测试因缺少评测模块失败，实现后通过；最终 7 个评测单测通过。
- `python -m mypy --follow-imports=silent src/notalone/memory_extraction/evaluation.py src/notalone/memory_extraction/evaluation_cases.py src/notalone/memory_extraction/adoption.py`：3 个文件通过。环境原无 mypy，本次仅安装到开发环境。
- 清空模型凭据后 `python -m unittest discover -s tests -v`：798 项通过，3 项跳过；其中新真实冒烟默认跳过。
- 用户授权的真实 24 条合成评测：21 通过、3 失败，退出码 1；详见 `docs/memory-extraction-evaluation-baseline.md`。任务 01 验收的是测量工具，失败留待后续维度票修复。
- code-review 两轴：Spec 0 项；Standards 1 条非阻塞维护建议（测试用稳定名称取代用例索引），已修复。`git diff --check` 通过。

数据影响：仅合成窗口发送到授权模型；不读取真实聊天、不连接数据库、不写入记忆，不改变自动采纳规则。未执行存储去重/写入裁决，未证明七维度达标或文本语义保真。

## Comments（收尾复核）

- 2026-09-15 独立验证：`python -m unittest discover -s tests` 798 项通过、3 项跳过；无凭据运行 `python -m notalone.memory_extraction.evaluation` 明确跳过并返回 2；mypy 对 evaluation.py、evaluation_cases.py、adoption.py 无问题；24 条用例名称与开发期脚本逐条一致，按 subject / truth_intent / time / reported 归类。
- 基线 3 条失败已挂到任务 04（吹牛被点破、修辞反问）与任务 06（无标记转述）复现修复；开发期脚本 `.scratch/pragmatic-memory-smoke-test/score_extraction_intent.py` 已被仓库评测入口取代，保留待用户决定是否删除。
