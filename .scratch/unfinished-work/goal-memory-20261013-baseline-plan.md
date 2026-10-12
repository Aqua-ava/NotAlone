# 持续目标：当前21窗真实模型基线预注册

前置是[technical实际6次200](goal-memory-20261013-technical-result.md)，不是语义已通过。沿[目标5个唯一run上限](goal-memory-20261013-technical-plan.md)，本阶段只激活baseline：`058fa1c2-d34c-41c5-9cbb-780e74bdd5eb`，真实HTTP硬上限42，SDK原2次重试也消耗这42次。旧run不恢复、关闭余额不挪用，不换UUID补齐；准备材料无真实HTTP或密钥读取。

## 固定材料与判据

- 保留当前原16个reference主窗、3个公开reference补充和2个公开核心观察，顺序为A01–A19、B01–B02，严格来自现有`_PLAN_CASES`及`build_window`，不删除none或难例。Gold为[既有结构化参考](memory-gold-reference-20261012.json)，规范摘要`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`；[原中文技术标注](memory-gold-agent-annotations-20261012.md)文件摘要`7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`。所有输入窗摘要与参考逐项匹配。
- 分母28必需命题＋A15可选1个，raw、accepted、full严格分层；none、额外、重复、排除、来源重复、字段fail/unresolved、安全及去向另报。原matcher/oracle分数原样保留，与新显式审核分开；整理者已读旧oracle，不冒称盲审、真实核心6/12、用户全窗认证或生产放行。
- 原生产E/V提示、schema、语用/来源/采纳/时间代码保持；SDK由已有`run_ecnu_evaluation`装配。唯一ECNU endpoint、ecnu-max、temperature0、thinking enabled、具名工具、timeout60及原fallback=false；不改供应商、标准答案、模型输出、门槛或默认空放行表。

## 显式审核及停止

桥只把`PhasedEvaluationAudit`的raw视图写成0600独占文件，操作者Agent根据固定公开参考逐行核14字段、命题语义/完整性/分支/来源/时间及禁止项，写显式raw审核。不提供自动全pass模板；缺项、未决和具体失败必须保留。原模块核对并持久封存raw后，桥才能提供full视图，显式核V四字段、E→V→程序最终层对应和实际去向，full审核不得改已封存raw。

单阶段审核等待最多300秒，绝对截止台北2026-10-13 03:00（UTC 2026-10-12 19:00）。源码/runner/bundle/目标索引/技术收据漂移、配置或HTTP契约/运行失败、审核缺失/非法/超时、未知或安全语义错误、落盘/计数/收尾错误均立即停止。一般语义错误保留并继续固定当前基线；安全错误或未决按原driver停止，不用多次重跑掩盖。后续reverse、comparison、full_regression不自动激活，需实际基线信号、另一次具体预注册与Root核验。

## 当前桥及验证

- 外部唯一工作目录沿用`/private/tmp/notalone-memory-goal-20261013-ac04d687/`（0700）；新增`baseline_run.py`、`baseline_selftest.py`、`baseline-plan-v2.json`均0600。实际输出另建`baseline/`及`baseline-reviews/`，不把内容或凭据提交仓库。v1计划和原桥`baseline_run-v1.py`保留，不领取或执行。
- 当前v2 runner SHA`bd4079e3263b0a04ec943174d9632a1b7fe4bee32b83f77ebc174aab6877b72d`，bundle SHA`c0f21a1c2c5b6b14b05ffc72a484e620b7a34320fa80f8b3500661b6e8e40dde`，60份必要源码/包/公开判据与冻结源码提交`7a61a001847bacd9f163210dd236b8d96c83c7e9`逐字节相同。入口及每个审核阶段复核runner、60源、bundle、技术完成收据及不可变总索引；原供应商contract在每个HTTP发送前复核源码/截止/具体请求契约。v1 runner`ce3d62...`/bundle`609a9b...`只作未执行历史。
- 外部桥mypy初次通过；8个纯文件交接/退出负控初次全绿，0.024秒，没有构造假red。覆盖raw私有保存/无full层、缺少审核停、非法权限拒绝、旧view不覆盖、freeze失败先于落盘、full位置非唯一拒绝、失败/不完整退出1、完整退出不认证质量。测试禁止所有HTTPX/HTTPX2默认transport、socket/DNS及loader真实密钥；临时目录finally删除，真实HTTP0。
- v1独立双轴共同发现阶段截止边界：文件在最后sleep之后晚到，或读取跨过300秒，原循环都可能接受。新增两条受控monotonic负控实际red（10项中2失败），补读前和读后阶段截止复验后10/10、0.023秒，mypy再次通过；没有实际等300秒或增加HTTP。摘要明确`mode=real_ecnu_public_synthetic`/mock_mode=false及实际provider_response_count；原driver保留的synthetic_only=true指公开合成输入范围，不能当作Mock或渠道证据，也不改产品源代码扩大本片。
- 既有Agent独立Standards与Spec终审均0项，60源与提交/blob/hash及21输入0差异，stage/ID/cap/截止未漂移。自检SHA`bfabca3689849788056bad11f7884e0b0b72c8ca1447dd17ccc441432952c5c1`。本桥当前尚未激活baseline；技术阶段已闭账6，记忆目标真实HTTP累计仍6。Root最后冻结核验后再执行，不能把工具准备算原票验收。
