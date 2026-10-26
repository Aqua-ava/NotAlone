# 单目标匿名对照结果（2026-10-03）

状态：这次最多20次的匿名试验已结束，单目标方案未达采用条件。整窗与逐条的最终完整正确保留均为6/8；逐条偶尔补出知识状态，却损失原臂的一条完整合法岗位正例，没有严格覆盖收益。未修改默认路径，整体记忆准确性修复未完成。

## 原话与保留结果

使用既有四条合成匿名消息，各方式重复两次；每条原话在每臂只有两次机会，不把四个分窗当成更多真值。消息时间全部未知，不能用试验日期补成事实日期。下表为最终完整契约覆盖，包含正文、人物、语用、阶段、日期与直接来源。

| 匿名原话 | 应保留的意思 | 整窗 | 逐条 |
| --- | --- | ---: | ---: |
| 我那位做设计的朋友以前参加暑期项目，项目报酬每天180元。 | 联系人的那位朋友过去的项目报酬，每天180元；第三人转述，pending。 | 2/2 | 2/2 |
| 那位做设计的朋友现在是正式员工了。 | 那位朋友在消息中的当前岗位状态；第三人转述，pending。 | 2/2 | 1/2 |
| 我不知道那位做设计的朋友现在的报酬。 | 联系人本人不知道朋友当前报酬；本人知识状态，不能写成朋友不知道。 | 0/2 | 1/2 |
| 我平时喜欢喝热茶。 | 联系人的平时喜好，不增添“只喝”“最喜欢”等限定。 | 2/2 | 2/2 |

最终两臂各保留6条，均完整准确；这表示已保留条目的准确性，不表示全部应记主张已被提取。整窗auto2／pending4，逐条auto3／pending3，均为未写业务的评测去向。新增一次合法auto不能代替完整覆盖或正例保护。

## 失败位置与归因

第一轮单target知识消息的首次E返回合法空，原话完整到达，仍未生成知识主张。第二轮单target岗位消息在当前岗位后又加了“此前参加过暑期项目”；窗口确实支持这段历史，但当前target不直接支持它，候选只列岗位来源、遗漏历史直接来源。正文没有编造，完整来源契约却不成立。

原V将第二条复合候选判为unsupported／disconnected_context并拒绝，这次拒绝正确；它不是拒绝完整合法事实。损失起于E加入独立上下文主张且来源不全，使原臂正确保留的岗位在候选臂整条丢失。不能补引用、删限定或放宽V来把该失败算通过。

| 统计 | 整窗 | 逐条 |
| --- | ---: | ---: |
| raw条目 | 6 | 7 |
| raw核心语义覆盖／原机会 | 6/8 | 7/8 |
| raw完整契约覆盖／原机会 | 6/8 | 6/8 |
| 最终完整覆盖／原机会 | 6/8 | 6/8 |
| 本人知识状态最终覆盖 | 0/2 | 1/2 |
| 本次整窗完整合法正例的保护损失 | 0 | 1 |
| 确定／纯歧义坏auto | 0／0 | 0／0 |
| 完整合法误拒／不必要降级 | 0／0 | 0／0 |

13条raw正文均得到窗口支持，12条完整契约正确；1条含额外历史主张且直接来源不全。机械UUID／target交集错误0，必要直接来源语义契约缺陷1。额外原子主张1、复合语义重叠1，完整合法重复及潜在重复auto均0；所有原输出、拒项与空返回保留，未进行业务去重。13项V判断中12 supported保留、1 unsupported正确拒绝；逐字证据真实不能替代完整语义契约。候选臂自身完整合法raw的保留损失0，与上表保护原臂正例的损失1采用不同分母。

这只否定了本次固定匿名集合上的采用假设。它没有证明模型内部漏选原因，也不证明任意长窗、真实历史或其他模型的效果。

## 运行与数据边界

批准依据为[提案](memory-single-target-omission-pilot-proposal-20261003.md)在9bbd88b的原版本，原批准SHA56995f6b…独立保存。两重复固定10位置，原E／V／system／14字段／Flow／语用／采纳不改，每个逐条窗口保留全部四消息，仅改单target标注。

9项不同unittest、7文件mypy／AST、2种原Tool的真实SDK只绑定及两轴预审通过后冻结。预检发现的收据身份门、统计措辞、辅助脚本类型与日志权限问题在联网前修正；初失败及旧版本保留，不算新语义样本。

实际命令在Conda NotAlone运行：`python -m unittest discover -s <私有目录>/runner-v1 -p test_single_target_pilot_runner.py`、`python -m mypy --follow-imports silent <7个私有源码>`、AST解析、`python <私有目录>/root_sdk_bind_v1.py`，以及一次带冻结指纹的`root_launch_single_target_v1.py --run`。完整命令、源码指纹及真实退出状态保存在私有root-unit-test-details-v2、root-type-check-details-v2、sdk-bind-only-v1与启动收据中。未声称这轮运行产品全量测试或完成产品集成。

唯一session78059终态exit0，10完整位置、19公开invoke（E10／V9）／19预约／19无正文台账、运行失败0、合法空E1、零保留位置2，未运行0。剩余1次关闭；不能补跑、调参、增臂或复用旧试验余额。只使用既有ECNU ecnu-max；不使用DeepSeek官方key、不直连或回退官方。19个响应reported模型名为deepseek-v4-flash，服务路由仍为ECNU；reported名称不等于使用官方key。SDKreported输入50,703、输出19,382，共70,085tokens，不作为HTTP次数或账单金额。

原始输出先独审冻结，再揭V／Flow及去向；审计者不是新runner作者，知道旧漏项及Gold背景，未宣称双盲或人类金标。独立运行闭环只能证明捕获和代码一致，不能代替上述语义评分。

独立闭环900/900项机械核查通过：184项冻结资产、315项去重资产字节匹配，10/10捕获按原E／V／Flow重放一致，9份原V内部元数据台账匹配；900项不是900个unittest。关闭门在凭据／factory／API之前拒绝后续运行，sentinel factory调用0。首闭环检查对旧关闭字段名、首完整语义检查对合法空E的null表示各有一次错误假设，失败凭证保留；仅修核查器后通过，捕获／Gold／规则未改、模型未重跑。root另核315项字节指纹和233项私有路径权限，六项采用门失败，后续开发／实际／留出／生产／发布授权均false。

可复查的私有凭证（均不提交Git）：

- [首raw全审](~/.notalone/audits/memory-single-target-omission-pilot-20261003/independent-audit-v1/raw-first-audit-v1.json)，SHA `7e98ac64426cbc30fb1237f600a3929e9b6bd3382aac631b8dc57e323b258f5a`。
- [完整语义审计](~/.notalone/audits/memory-single-target-omission-pilot-20261003/independent-audit-v1/full-pipeline-audit-v1.json)，SHA `3ba05d30ff678fa4e102ac3835d33d875cfcdc3232d96db69f65d14a512aa418`。
- [独立运行闭环](~/.notalone/audits/memory-single-target-omission-pilot-20261003/runtime-verification-v1/runtime-closure-v3.json)，SHA `2d7838d425a27fe71c440e821d0f8c7b247a47bffc9507e73a8ff247f2399002`。
- [root失败门与闭账](~/.notalone/audits/memory-single-target-omission-pilot-20261003/root-failed-gate-and-closure-v1.json)，SHA `9963be05398553ee64459a8441a6603b8c89a782029902d1db5fbabf15b39603`。

本轮不读取真实聊天或留出，不写业务记忆、水位或旧五条资料，不修改生产源码／配置，不发送外部聊天，不做远端Git。SDK内部HTTP尝试次数、账单金额及供应商外部副本删除未观察。原实际历史必需6/12、可选2/6及最终同批／留出验收要求保持，本匿名pilot不完成原spec。

私有证据目录：`~/.notalone/audits/memory-single-target-omission-pilot-20261003/`；目录0700、文件0600，捕获与审计不进入Git。
