# 原03正式十五窗入口：本地工程接线结果

Triage: ready-for-agent

2026-10-17，正式十五窗验收的来源、指定任务、封存审核、独占进程和资料生命周期接线已完成，源码固定于`4441c81eeb94517d4770acb996509ef14e96dfa7`。本记录保存工程结果；真实模型交付与七轴质量成绩仍为空，原03保持`claimed`。

## 实际完成的链路

- 十五个完整公开合成窗口按预登记顺序准备：三窗经过正式JSONL导入，十二窗经过合成已确认绑定的观察记录。每窗由生产loader恢复实际来源、处理收据和原时区，并核默认window builder恰好生成一批；不裁窗或补造可信元数据。
- 正式任务保存`bounded-runtime-v1`配置，执行同一次E2/V3及生产Worker，读取实际PG追踪和候选API。完整Window、实际消息UUID、owner/contact/task、规则摘要、Gold、源码、迁移、模型合同及安装版本分别冻结；旧默认与空放行表保持。
- 同次SDK与预算transport保存HTTP证据。RAW先封存，FULL逐轴审核；假事、错人即使遇FULL中断也独立保留已知计数，未完成审核不加入七轴分母。模型、技术及审核未知均停止，不重试或补跑。
- 使用原公开入口的`prepare-bounded15`及独占worker，限定三十次HTTP、SDK I/O三百秒、单调用／审核六百秒、整场四小时。准备与验证不领取真实预算或读取凭据；本轮所有SDK通信均为Mock。
- 完整十五窗质量、六规则交付、双请求frame及进程关闭门通过后，才对该场实际候选验证三个代表：P01联系人确认及修正、P06本人资料确认及修正、P02拒绝指纹。三者先独立复核当前来源；确认、修正和拒绝继承ALL与原sources，人工修正版不恢复旧proof信用。其他pending候选完整保留。
- 先独立封存十五窗当前task/API/trace原件，再操作资料；生命周期结果绑定run及冻结摘要。结果文件截断或收据写入失败仍独立归档PG原件并清理，失败／未知照实记录。来源适配层核精确所有权后执行正式源级删除、十三类残留检查及自有库删除；归档失败保留原库。

三个代表的生命周期控制不扩称为十五窗逐项完成全部操作。复杂回复传播、旧资料及多引用保护沿此前工程矩阵单独记录，不从质量分数推定。

## 验证记录

环境为Conda `NotAlone`，显式关闭dotenv，设置绝对`PYTHONPATH`及`PYTHONDONTWRITEBYTECODE=1`；集成回归显式清空专用评测key。以下保留各组原口径，不累加重叠检查。

| 命令或检查 | 结果 |
| --- | --- |
| `python -B -m unittest discover -s tests/unit/memory_extraction -t .`（backend目录） | 668项，OK |
| `python -B -m unittest discover -s tests/integration/memory_extraction -t .`（backend目录） | 原报告132项，OK（skipped=3） |
| `python -B -m unittest tests.integration.tasks.test_bounded_evaluation_sources -v` | 14项实际隔离PG／SDK Mock控制，OK；精确自有库残留0 |
| `python -B -m unittest tests.integration.memory_extraction.test_bounded_public_fixture -v` | 5项，OK；含实际独占子进程、截断结果、收据失败及清理 |
| 原`test_reference21_v4_public.py` | 15项，OK；旧21／semantic4／uniqueness路径保持 |
| 15个变更Python源码的定向mypy | OK，使用`--follow-imports=silent --ignore-missing-imports` |
| `git diff --check`、公开历史及当前文件扫描 | OK，0 issues |

集成组的跳过项来自缺少专用真实模型凭据或未显式指定旧追踪测试隔离库。正式任务、追踪、生命周期及删除的新增PG控制均使用本次随机创建的自有`_test`库。以上不是全项目类型检查或真实模型验收。

工程控制曾发现归档目录遗漏，导致两个自有合成测试库被保留；已按确切库身份及完整十五窗内容核对，先私有归档再正式删除，十三类残留及库删除均为0。未处理未知归属库。

## 两轴审查与修复

独立Standards／Spec固定`ff4a3870...82ac12e7`审查。Standards的一项职责分离问题在`c9a9fd2b`关闭；Spec的RAW安全计数及实际输出生命周期缺口分别在`07cf3c6d`、`b3d3109f`＋`ccce9ea2`关闭。补充的结果／收据异常退场缺口在`4441c81e`关闭。各修复均有独立小范围复审，最终新增硬规范、判断项及实质规格问题均0。

固定十五窗、二十个合法variant、一百零五项独立轴判据及Gold含义保持；没有依据当前输出修改样本或预期。

## 剩余验收

本轮真实模型HTTP为0、真实评测预算创建为0，未读取凭据、业务资料或桌面画面，未执行业务库迁移、聊天发送或远端Git。

仍按核心事实→指代07→原03推进。核心技术恢复例外单独待确认；不占其五十六次额度或任何已封场余额。原03真实运行前须在最终集成代码上新建实际来源／任务及唯一冻结场，按[十五窗计划](bounded-runtime-real15-plan-20261017.md)完成实际六规则交付、七轴质量和上述生命周期收据；全部通过才更新原票Answer、AC与`resolved`。当前工程通过不提前关票。
