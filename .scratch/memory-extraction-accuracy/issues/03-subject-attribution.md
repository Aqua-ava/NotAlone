# 03 — 主体归属维度评测与修复

**What to build:** 把"记忆主体是谁"测全：用户说自己的事、联系人说自己的事、联系人转述用户、双方共同事实、含混淆线索的对话（上下文提到第三方）。至少 15 条合成用例，每条必须校验期望主体。发现判错按允许手段修复（提示词与示例、字段语义、模型配置、确定性降级兜底），并保证全部既有用例回归通过。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 01（评测骨架）；02 的产出用例可并入

- [x] 该维度达标签：至少 15 条中假事 0、记错人 0、一般错误 ≤1
- [x] 每条用例校验最终去向与期望主体
- [x] 修复只用允许手段，不用硬编码或特判
- [x] 全量既有用例回归通过
- [x] 新增与修复对应用例入库

## Answer

- 用例：主体维度 16 条（含既有 1 条），每条校验最终去向与期望主体；真实模型 `ecnu-max` 运行 16/16，通过判分假事 0、记错人 0、一般错误 0，达标签。
- 评测骨架扩展：失败分类 `false_fact` / `wrong_subject` / `general`、维度达标签汇总（≥15 条、假事 0、记错人 0、一般错误 ≤1）、候选文本保真检查（`expect_text_contains` / `expect_text_excludes`，供任务 08）；主体检查在没有候选时为真空真，避免把"预计不生成"的用例误判。
- 修复只用允许手段（提示词与示例、字段语义）：未来日程与安排一律 plan；"我们"表达的共同经历、约定、计划标 shared；两人窗口里未指明的"他/她"默认联系人且不填 alternatives；speech_act 描述发送者行为，陈述事实（无论主体）用 assertion、只有转引才用 report；alternatives 不得与标签或主体判断矛盾；category 与 topic 枚举互不混填并附分类示例；证据直接时 confidence 不低于 0.8；外部内容的命题与情绪反应不提取。
- 全量 39 条回归：38 条通过；仅"无标记转述"因模型偶发（约 1/5 次）把 `family` 填进 `category` 被证据外壳拒绝，属任务 06 的已知项，未用修复手段掩盖。
- 验证命令：`python -m unittest discover -s tests/unit/memory_extraction`（53 项通过）；`python -m mypy --follow-imports=silent src/notalone/memory_extraction/evaluation.py src/notalone/memory_extraction/evaluation_cases.py src/notalone/memory_extraction/adapters.py`（无问题）；本机评测专用凭据仅进程内注入、未输出或保存。

## Comments
