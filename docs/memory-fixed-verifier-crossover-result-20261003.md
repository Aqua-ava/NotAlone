# 固定候选核验对照结果

状态：2026-10-03，24次固定对照和全量独立语义审计完成，固定阶段未达门，关闭这一配置。没有生产配置变更；完整记忆修复目标仍未完成。

## 执行范围与证据

沿[冻结计划](memory-fixed-verifier-crossover-plan-20261003.md)使用同一已确认联系人的6窗、12份原捕获、17条候选，分别执行ecnu-max与ecnu-plus原核验器，两臂各12次。未调用提取E或修订R，不重提历史，不读取留出。所有24份公开messages、schema和tool_choice与原捕获输入相同，仅模型配置不同；未观察HTTP wire，不能把公开输入核对称为HTTP逐字证明。

首次启动因私有工作目录未找到项目.env，在工厂检查处停止，0预约／调用／台账；首失败保留。随后按[初始化修复边界](memory-fixed-verifier-bootstrap-resume-20261003.md)显式定位原项目.env，只续行一次，复用原24预算。session80674终态exit0，24预约、24公开invoke、24台账及24位置结果完整；不补发失败位置，不再启动入口。

运行失败2次：ecnu-max的invalid_output一次，ecnu-plus的APITimeoutError一次。失败仍计入全部原候选与参考机会分母，不称为空提取，也不从语义统计中删除。

## 成本与运行限制

23次返回报告模型名：deepseek-v4-flash共12次、qwen3.8-flash共11次；超时没有响应模型名。请求别名与响应报告名分别记录，后者不能证明权重、架构或模型独立性。当前plus报告名与旧试验记录不同，因此不能把本次结果归因到旧记录的模型规格。

已报告tokens为88,259（输入63,704／输出24,555）；一次超时用量未知，不当作0。续行执行耗时446.105秒，包含续行校验、构造及调用循环，不含较早launcher校验、CLI／Python／Conda启动或首个失败进程；公开调用跨度445.174秒。SDK内部HTTP尝试次数未观察，货币费用未推断。

## 语义判断

独立审计覆盖两臂全部34个候选位置、55段公开引用，沿联网前冻结的原17条矩阵、Gold及比较规则判断；原标签与规则字节未改。auto均为评测模拟去向，业务写入0。

| 指标 | 原捕获 | 本次max | 本次plus |
| --- | ---: | ---: | ---: |
| 接受候选 | 15 | 14 | 10 |
| 完整正确候选保留 | 9/9 | 9/9 | 7/9 |
| 已知契约错误候选保留 | 6 | 5 | 3 |
| 通过返回契约后仍错误supported | 3 | 5 | 1 |
| 确定错误auto | 0 | 1 | 1 |
| 必需严格覆盖 | 6/12 | 6/12 | 6/12 |
| 可选严格覆盖 | 2/6 | 2/6 | 1/6 |
| 失败调用位置 | 0 | 1 | 1 |

plus损失2条原本完整正确的候选：1条随超时丢失，1条正确第三人转述被subject误拒。两臂均新增1条确定错误auto，把建议误记为用户本人事实。plus的错误保留及错误supported减少，仍不能抵消正例损失、可选覆盖下降和坏auto；不能称为整体准确性改善。必需覆盖没有变化，固定V不补原raw缺失的事实。

49段通过返回结构校验的引用全部合法，保留的9／7条正例的新引用均完整支持其含义；这不证明错误候选已被修正。max一次返回的6段引用字面均真实，其中1段来自窗内但未被候选声明的来源，正确触发整批invalid_output。表中错误supported只计通过返回契约的结果；非法返回另有1项错误supported，私有逐索引审计照计，但不混成有效判断。失败造成的少输出不算语义检测收益。

root独立复核聚合算术、原17分母、9正例／8缺陷分组及预先冻结的全部条件，与独审关闭门一致：`approved_for_next_phase=false`。不运行开发、自然实际、留出或生产，不补调用、不循环调整这一配置。完整目标仍包括有效修复与同批自然复测；本轮只关闭这一实验路线。

## 核验职责的限制

源码只读核对确认：合法unsupported由原Flow硬拒绝；uncertain只增加semantic风险并保留原候选，通常进入pending。因此协议可以减少错误保留，但把supported改成uncertain只是降级，不能称为错记已经修好。确定性的来源／target／quote硬门验证编号、范围及字面片段，不能单独证明片段支持全部含义；引用真实与主张准确需分别审计。参见 [Flow](../src/notalone/memory_extraction/flow.py)、[证据契约](../src/notalone/memory_extraction/verification.py)及[ADR-033](../architecture/adr/033-source-semantic-verification-before-adoption.md)。

V不能改正正文或主体，也不能补原raw没有提取的主张。issue表示错误轴，不表示确定性等级，不能把全部uncertain按meaning／time／pragmatics标签直接删除；这会改变现行“证据不足待确认、无支持拒绝”的政策。本轮不实施这种政策变更，不用拒绝全部候选获得较低错误数。

## 验证与数据处理

联网前root独立17项匿名runner测试与10项初始化续行测试通过，原12次公开输入／完整Flow去向0API重放等值（17raw→15接受／2拒绝），原额外键正确候选保留。实际24次公开输入核对全部相同。这些检查证明准备与接缝兼容，不能代替语义收益证明。

匿名测试命令入口如下；root独立复跑结果来自当时终端观察，私有final-green日志是准备测试的持久化记录，不替称root复跑耗时。实际联网入口为同目录的 `root_launch_resume_v2.py`，本批已终态，不重启。

```sh
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/Users/local-user/learn/NotAlone/src python ~/.notalone/audits/memory-fixed-verifier-crossover-20261003/test_crossover_v1.py
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/Users/local-user/learn/NotAlone/src python ~/.notalone/audits/memory-fixed-verifier-crossover-20261003/test_bootstrap_resume_v2.py
```

独立运行规范审计确认：唯一预算与启动／续行凭证、首失败、12项源码与3项评测字节指纹保持；私有权限通过，生产无差异。业务记忆、旧认可资料、水位写入均0，官方服务调用0；没有外部聊天发送或远端Git。原话、公开I/O、Gold、逐索引材料仅在仓库外0700／0600目录，未保存内部思考。本页只记录聚合数据。

私有聚合证据位于 `~/.notalone/audits/memory-fixed-verifier-crossover-20261003/`：

- 原计划 `frozen-plan-v1.json` SHA：`5fe3d996b88318efc4c8de57f34402893589517cca2bdc5b0b838c791d7972e4`。
- 原执行冻结 `freeze-v2.json` SHA：`c3093a11424e1a7bb9f9c7a8b364b210e3f13d5122ab4760133f28b42defadfa`。
- 续行冻结 `bootstrap-freeze-v2.json` SHA：`a937197fb8cd2520f994f63777a9accce7091ec36ed5c3830aa8f1b77e49617e`。
- 原17条矩阵 `independent-audit-v1/frozen-original-candidate-matrix-v1.json` SHA：`1cf1e46751ffef2ad508cb03838d71bd0cb7c82e9e5eee00ebd7ed438d13af5a`。
- 联网前判断规则 `independent-audit-v1/frozen-comparison-rules-v1.json` SHA：`a8db068de9cc5ab3ebd8a140b07481c57450d907f7314fc2600154e1d7df8ee6`。
- 实际公开输入核对 `root-live-input-equality-proof-v1.json` SHA：`4f92e8a0073ac6114d94d8b081782277b245f871fb8bfdd08067a0f6eb859b1a`。
- 运行规范及成本审计 `standards-runtime-closure-v1/aggregate-runtime-cost-and-guard-closure-v1.json` SHA：`c5be5644477dc38b8aa3d1334e185a038dc569f706076d171f458a35de9ef859`。
- 17项匿名准备测试日志 `final-green-v1.log` SHA：`f5bc5dd2935d07dd7628d300a06393195ccf439f58d27e9b710f7deeeeb4eef7`；10项续行准备测试日志 `bootstrap-final-green-v2.log` SHA：`e9dd39ea985ab1ee6e60126e52126275ebc0c8d92f021bffdb9321e405af1f61`。
- 全量语义审计 `independent-audit-v1/full-independent-semantic-review-v1.json` SHA：`302e7550df9c6f98edf4feeb24bc6c46cdc4231c5e3a8bbc4e51e114c7dc5c82`；安全聚合 `aggregate-independent-semantic-review-v1.json` SHA：`dd24a9df6add88513badc17a818cddfa656ddb1332b784451618ca0f902412ec`。
- 独立关闭门 `independent-audit-v1/fixed-stage-independent-closure-v1.json` SHA：`e11896d3337dc22963611eaa54a9ab1907228490c97adceaa528edf1fd6126d9`；root聚合及门复核 `root-post-audit-closure-proof-v1.json` SHA：`f7384e461efb85b6f446d44a0cf81ec57386d302239e610bf8a83b506be8bfce`。

预运行文档保持在本地Git历史：固定计划提交 `5e40b19`，原页SHA `cdb1a2c71ab0ecb698a4adde638b85fa64a3a28f37244b219481323a35868944`；初始化边界提交 `ee97801`，原页SHA `a96abd213f3adecba873f606a59c41390756deeff63c6ab6cc57e0d33983280f`。执行终态后更新两页状态，只补结果导航，不改原判断或失败。
