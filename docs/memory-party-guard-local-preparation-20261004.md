# 主张人物核验的本机归因与准备

状态：本机准备与相关验证完成，新的匿名范围待决定；不代表记忆准确率提升或整体修复完成。用户“继续下一步吧”沿原ticket授权本机归因、可运行准备和具体方案；当前新增模型调用0，所有旧试验预算关闭。

## 定位结论

[上轮来源语用结果](memory-source-pragmatics-pilot-result-20261003.md)已有8次真实V，独立来源标签只正确4/12，坏auto未减少，并损失4项正确转述。此次先冻结四个可证伪假设：提示／schema冲突、E标签泄露、编译或Flow丢字段、模型混淆说话人的确定程度与主张当事人。

只读核对实际已冻结请求后，未见允许第三人assertion的直接矛盾，来源提示已有report/reported规则；源臂动态投影没有E三标签。公开captured返回经原`verify → ExtractionFlow.run → can_auto_adopt`重放，错误两项仍`supported/auto`，热茶仍正确auto；没有确定性字段丢失或门被绕过。不能据此排除正文／分类字段的间接影响，也不能把“模型混淆人物”当作已证实因果。

worker同一首安全断言命令重复两次，均exit1、1个失败／0个错误。按单一轴先缩到一个候选及其原返回，再缩到该候选的一个来源消息，预期安全断言仍失败；每步重跑完整捕获及热茶控制。这里是程序传播的最小化，不是模型在缩小输入后仍会错的实测。worker共3个不同测试方法、11次捕获重放；root另独立运行安全red及热茶green两条命令，没有新模型样本。

知识状态遗漏独立定位在E首包：旧联合捕获已包含“我不知道朋友报酬”target，coverage却为`not_reusable`且无候选；V收到上下文也无权新增事实。历史知识专门说明、text单叶及R补漏均已有失败记录，不能重抄为新修复。新人物方案只检查已有候选。

## 原接缝内的可运行准备

使用`diagnosing-bugs`建立首红与假设，再用`codebase-design`固定既有接缝。原产品V为基线，追加临时人物判断与原话片段，编译出口仍为原四键；原14 Fact、Flow、采纳与存储接口不变。

设计审查曾建议在失败source三标签方案上叠加人物字段，以相对该方案少改因素；root选择完整原产品V作为同期基线。失败source从未采用，而它对正确B标签的误降级不能单靠认对人物消除。该取舍必须保留：本轮不是相对失败source的单变量因果检验，也不声称与它等价。

新增人物六值及证据仅存在私有核验wire。唯一编译规则为`supported + third_party + E assertion/asserted → uncertain/pragmatics`。不改正文、来源、subject、时间或E标签，不给mixed／unclear额外降级，不升级既有计划、非字面或未知状态。具体字段、严格整包失败、正例保护和24次待决定范围见[有限提案](memory-party-guard-pilot-proposal-20261004.md)。

离线控制使用人工契约返回，验证新增guard、索引、逐字来源、原Flow去向及隐私先过滤；它们不能证明实际模型认对人物。必须保留错判contact仍auto、mixed／unclear未覆盖以及“合法quote只定位认知对象”的反例。

worker最终9个不同控制通过，5个纵切分别保留首red／green，其余既有保护控制首次即绿，没有伪造首红。内容覆盖窄guard、人物证据source／target／逐字／非空、六键及完整索引整包失败、原请求／提示优先级、正确转述与本人状态、旧语用门及不升级、嵌套隐私过滤、乱序索引、未覆盖反例。supported人物null造成整包包括正确热茶丢失，作为结构损失保留；non-supported null不能升级。

root另4个不同控制通过，使用提案C1—C4原14输入：逐值比较新／原V实际生成的user请求，比较完整Flow Fact及语用决定，确认auto／pending保护。C3正确第三人人物时新增语义风险并pending；人物错填contact且引用合法对象“我工资”时仍auto，证明逐字quote不替代人物理解。4条原四键人工参考也经公开Flow验证；这些是同一四条fixture的接口检查，不能合并成8条模型样本。

worker最终3文件mypy／AST通过。root首4文件mypy／AST通过，随后仅root长行格式变动，AST无位置等价；终检root1文件mypy及4AST通过，4控制复跑通过。worker3源格式也AST等价；首次类型失败、旧构造器测试快照、所有首红和格式前检查原样保留。最终suite61次scripted边界调用及17个留证test进程累计201次scripted调用只是人工控制次数，真实API／SDK构造／凭据／网络／业务读写均0。

独立参考审查确认四条主张与人物边界，C2是联系人自己的知识状态，C3是朋友的知识状态；C4初始手工多写完成体“了”的输入保留，调用前修正。未知消息时间、生效／失效日期均保持未知，不用运行日期填事实时间。

## 证据与实际命令

私有根目录：`~/.notalone/audits/memory-source-pragmatics-diagnosis-20261003`。目录从10月3日开始，10月4日继续，未换目录重置证据。文件0600／目录0700，首次失败及修正分别保存，未把捕获内容和内部思考提交Git。

已完成的捕获反馈证据：

- 首次red收据SHA`1f8c99d83c2e6fc239a1aa005603727d77fae6eb37b747f4fcbbb460550ea0d0`，最终可重复收据SHA`659ef54f176bd0223d9aae37df464c88375ba34c6a2f8f8820f95c6ef465e99e`。
- root独立反馈收据`root-feedback-replay-v1.json`，SHA`11459fdad3976a558df82bff498b81df1459f59c94c095d0b4294045652af1c5`：错误仍红、热茶绿。
- 方案决定`preparation-design-v1.json`，SHA`64b6798a590f96ee29eeb7d4fbed3237d793b0170903990d289a75d4de84f618`，新调用授权0。
- worker最终实现收据`implementation-v1/local-party-preparation-final-receipt-v2.json`，SHA`0a5ff909d8d3e89594b9bf05c0e40d607df5e588fa04f8a965c000241d18841c`；9控制收据SHA`b50467e643505fbba2f9b68ee11cd6baa045d1b33b1e7b9d55ed365b3664a604`，3文件类型收据SHA`b8d1d206e12c7a6270f7d0ecf336e7abc4a85808a9f9dc9987157a9d0df4ba81`。
- root最终4控制收据`root-contrast-checks-final-receipt-v2.json`，SHA`e24d2b7df679a9e562f92a9c0592de2e1c9203d82ed78d3f77a3f78f56f087dd`；类型收据`root-type-final-receipt-v2.json`，SHA`494d26da20a2a74d4919a55cbf0c6b22ef7ac46c246589b7acf478765714485a`。
- 独立参考记录SHA`f4463db6917bcd67ee9b89ba6f0276f03199dc1ff88cf0f8103c5a20c0491a0e`。root交叉核对收据`root-preparation-crosscheck-v1.json`，SHA`d9a9ab86b7a8c9a4319c8268c058d5d4f67a47d79c476714d6e858496ef4f4ac`：114个不同字节指纹与196个私有权限条目通过。明确依赖核对不是全部动态import闭包，不混作模型样本。

root实际运行，Conda环境NotAlone，cwd为私有`feedback-v1`，设置`PYTHONDONTWRITEBYTECODE=1`：

```sh
python -m unittest -v test_captured_feedback_v1.CapturedFeedbackTests.test_third_party_reports_remain_pending
python -m unittest -v test_captured_feedback_v1.CapturedFeedbackTests.test_direct_hot_tea_remains_auto
```

第一条exit1／1failure是原缺陷的预期红，第二条exit0。通过重放不证明修复；原捕获依赖未改。

另外实际执行的最终命令（Conda NotAlone，`PYTHONDONTWRITEBYTECODE=1`）：

```sh
python ~/.notalone/audits/memory-source-pragmatics-diagnosis-20261003/implementation-v1/local_control_driver_v1.py controls-final-v2
```

worker3文件类型检查在项目cwd执行，AST核对随收据保存：

```sh
python -m mypy --no-incremental --cache-dir /dev/null --follow-imports=skip --ignore-missing-imports ~/.notalone/audits/memory-source-pragmatics-diagnosis-20261003/implementation-v1/party_guard_runtime_v1.py ~/.notalone/audits/memory-source-pragmatics-diagnosis-20261003/implementation-v1/test_party_guard_v1.py ~/.notalone/audits/memory-source-pragmatics-diagnosis-20261003/implementation-v1/local_control_driver_v1.py
```

root4控制在私有根cwd执行；最后类型检查在项目cwd执行，`MYPYPATH`精确值及首4文件命令见root类型收据：

```sh
python -m unittest -v root_party_contrast_checks_v1
python -m mypy --no-incremental --follow-imports=silent --ignore-missing-imports --cache-dir=/dev/null ~/.notalone/audits/memory-source-pragmatics-diagnosis-20261003/root_party_contrast_checks_v1.py
```

上述最终命令均exit0。本轮产品源码未改，没有重跑旧1145项全量或把历史全量当成本次结果；文档只核链接／状态／计数和任务diff。早期worker类型命令使用默认缓存，可能更新项目忽略的`.mypy_cache`；保留实际命令，不删除共享缓存，不把缓存算产品／业务变化。最终检查禁用缓存。

## 当前边界

两轴独立终审覆盖任务四文档、当前四私有Python及限定收据，排除并行macOS工作；结果分别保留：

| 轴 | 当前发现 | 范围限制 |
| --- | --- | --- |
| Standards | 硬规范0；非阻塞测试重复气味1，可选抽原四键参考转换helper，本轮不扩大范围重构 | 没有把人工控制或哈希核对称模型样本 |
| Spec | 当前缺失0、scope creep0、实现错误0 | 整体有效修复、实际同批和最终留出仍未完成 |

Standards收据SHA`67ec2ca84b79436baefafbac46f11e147a728571e0d318407a47b504db550d4a`，Spec收据SHA`300cd863413baf2a96ca2404f134246d3472abdf0ec06d6a6c7d4f538d2f927b`，均在私有根`closing-*-v1.json`。审查没有新增测试或模型调用。四文档内部链接／新增引用SHA、任务状态及暂存差异已最小核对；按工程规则保存任务专属中文本地提交，不含私有材料。

新人物协议还没有实际模型返回，准确性收益未知；“本人不知道朋友报酬”仍未补提，实际必需6/12及可选2/6不变。没有产品源码／默认／业务／水位／旧五条或远端Git变更，没有读取真实凭据、实际同批或private heldout值。上一检查点曾披露的少量旧仓库合成留出搜索暴露不能泛称从未发生；本次没有继续读取或使用。

只在本机准备和具体提案可复核后，就新的协议／调用范围按[工作流决策规则](agents/workflow.md)决定，不让用户逐条代做普通核验。整体ticket仍未完成。
