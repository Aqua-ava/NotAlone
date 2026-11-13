# 09授权学习与待审草稿集成验证

日期：2026-10-16。固定M2 `08c4d48e719353492f37620f4fb2aabd8710efc6`、来源S `54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616` 不变。本记录签收正式09，细节及原始私有日志指针见[09 Answer](issues/09-learning-drafts.md#answer)。当前进度见[任务索引](planning.md)；页面、SDK本地传输和实际App／真实模型质量分别计证。

## 来源、审查与合并

来源为固定 `562f85e4→e88a983e`，实施基线为已领取09的clean根 `3200fc65e739c522b4406058804e0cb132dea4f3`。canonical064与源e88a983e的063逐字相同，SHA256为 `c59bc7779ed497c127b1f4822a051ef72d21de9dfa4d8508224d124b44a7132d`；原001–063及M2原001–058未改。没有新增prepared冻结字段，codec version2／schema_revision4保持。

| 独立审查轴 | 原发现与修正 | 最终结果 |
| --- | --- | --- |
| Spec | 原025候选P1：生产thinking enabled的DeepSeek学习请求强制具名tool_choice，与官方请求合同冲突。省略强制选择，保留唯一提案工具、坏工具调用及完整normalize拒绝门；实际builder与SDK本地MockTransport补red／green | 原P1关闭，新增及未关闭0 |
| Standards | 完整及三文件增量按仓库规则和全部12项Fowler基线核对 | 硬项0／possible0 |

完整审查为 `3200fc65→0255565a0c6337903bd8b16ac6527c7c2a23d686`，增量复审为025至 `6370c06b0801efd268af80de54855138b918526d`。审查者只读核对既有运行与原字节，没有另启业务资源。独立merger在预期clean根无冲突no-ff合入 `dff25a77ca410612928d4d88c7157a9ba849cf70`，合并树与6370候选完全一致，树为 `29f82aeaa1949bcd3d36429ec03694341516c032`。

## 交付合同

- 学习用途按owner与已确认contact明确授权，默认关闭；修订CAS与动作幂等不让旧启用动作覆盖后来的关闭。纠正优先、普通经验有界合批；无新增／复用也登记消费，原Worker租约、前台优先、停止和verify恢复继续有效。
- 取材只在学习接缝局部允许合法历史候选及用户编辑，当前生成的严格依赖不全局放宽。实际偏好使用、样本与其递归来源进入完整闭包；来源、样本、偏好及材料世代在领取、恢复和落库时复验，撤权、修订或删除拒绝迟到写入。
- 删除在原事务直接擦除草稿策略、私人依据、批次及恢复副本，手录偏好无reply_request也被覆盖；合法独立样本保留与其聊天来源删除规则分开。候选旧样本／版本测试按基线已有排队即擦除行为校准，没有放宽产品读取门。
- Main、preload和React提供可查看、可恢复的待审草稿，保留既有异步作业、A→B→A隐藏缓存和独立草稿。待审草稿不进入当前运行Skill目录，不开放发布或聊天发送；仅使用001–064，不查询未建审核／政策表，后续11–13继续承接。
- 07／08冻结结构、500条历史ID、三处SQL消息范围、共享3次／16条／2048估算token预算、三处生产Grounded默认和默认未放行质量门保持。合成优先级夹具的显式维度配置不表示生产放行。

## 分轮验证与原失败

下列均为实施者实际运行，merger没有重跑动态组。范围有重叠，不能把各轮相加为一次全量成绩；全部资料为合成数据，外部模型HTTP尝试为0。

| 实际轮次 | 结果与恢复边界 |
| --- | --- |
| 建库守卫模拟 | 无DB15/15；修复dict_row身份读取后16/16。验证planned先于CREATE、失败CREATE无DROP权、首次拒绝poison后不再CREATE但允许确证created清理，以及名称／双URL／导入前门和未覆盖客户端路径的拒绝 |
| 最小smoke | 首轮实际1项失败，私有守卫tuple下标误读dict_row身份；2个created库均精确absent。修复后4/4，5个created／cap5全部absent，覆盖全量64、真实063→064及重复0 |
| 学习及跨票 | 核心27/27；偏好来源反例先失败后1/1。新增四项跨票首轮3过1测试payload错误，改实际公开嵌套结构后4/4；每轮已created库逐名核销 |
| 单元 | 相关41首轮38过3失败，补07导航查询夹具后41/41；完整首轮错误PYTHONPATH为1389含1error，正确 `PYTHONPATH=src:..` 后1394/1394。此全量属于025候选，未把后加SDK方法冒称新版本1395全量 |
| 相关14模块首轮 | 原静态196加4跨票为200；failfast实际64＝63过1失败，6库全absent。旧样本断言未跟随基线同步擦除；窄恢复首轮未到方法即module guard拒绝，再轮剩余身份断言失败，最终1/1。直接核对旧父仍409、子物理删除404及2次生成，保留重放／续写拒绝 |
| 相关恢复与优先级 | 实际152＝151过1失败，11库全absent；旧优先级夹具自由正文适配真实Grounded与E／V／A。尾组8＝7过1问句标签失败，窄方法失败后1/1；尾组10＝9过1阻塞调用可变工具名失败，固定每次调用名后停止／31秒租约恢复／失败预算方法1/1 |
| 未到达尾组与候选 | 首轮31＝30过1失败，worker10与来源删除15已过；旧候选版本期待pending409。按基线擦除合同核对B版本0、独立A精确版本1与空当前选择，窄方法1/1；候选最终9/9、11.192秒，再补强精确身份单方法1/1、3.113秒。各轮2个created／cap2均absent |
| 优先级最终组 | 15/15、112.215秒，2个created／cap2均absent。仅该合成类显式设置维度门；真实Grounded原文分句、独立V、双裁决E／V／A／A及停止台账断言保留 |
| 桌面安全与纯组 | 学习Main／preload／视图／删除恢复16/16，页面门禁另1/1；类型检查通过。npm test首轮65＝64过1 eager页面manifest导入失败，case内lazy import后互斥窄组首轮仍失败、再轮1/1，完整65/65。safe命令未运行App或浏览器 |
| 实际React页面 | 原025候选，单Chrome、240秒上限，1 case／1 scenario通过；真实生产Main／preload／React→HTTP／隔离PG。learning模型started＝seen＝1、硬cap1、外部0；该计数只覆盖learning模型，准备为直接SQL合成来源／消息及公开讨论inputs，没有C生成 |
| 审查修复SDK增量 | 经实际build_deepseek_model与ChatDeepSeek序列化，red为1方法5子例失败、5次本地Mock派发、0.220秒；green为1方法5子例通过、5次派发、0.226秒。每轮cap5／15秒、固定本地端点、合成key、禁tracing、关闭同异步客户端。另runtime＋proposal 11/11、0.004秒及tsc通过，无PG或外部HTTP |

最终相关范围分阶段通过的唯一方法为前151＋优先级15＋worker10＋来源删除15＋候选9＝200；窄组与重叠组不再加数，**不存在单轮200/200**。SDK增量没有重跑200、65、1394或页面。[官方请求合同](https://api-docs.deepseek.com/api/create-chat-completion/)及本地SDK反例证明请求配置修正，不代表已观察真实服务400、真实DeepSeek成功或提案语义质量。

## 页面身份与资源边界

原页面核对授权、纠正材料、草稿与私人依据、联系人切换、同库后端重建、撤销授权及来源删除后刷新无复活，运行Skill目录为空。直接runtime记录15关键Python模块路径／SHA、exact001–064／repeat0、导入前planned与Core身份一致、child exit0及database_remaining=false。2个执行artifact和4个唯一浏览器资产共8次响应的原字节私有保留。独立原owned-identities的15个精确PID后置ps均不存在，App／headless双租约复查absent；runner释放门、直接字段和独立观察不混作同一种证据。

15个关键模块原SHA均对应025；至6370其中14个未变，仅learning_runtime为新的请求合同字节。merger从固定Git独立复算此差异，不把旧页面转称新运行时已执行。SDK本地传输增量与原页面共同提供接缝证据，实际App／微信／真实模型仍待最终组合。

私有资源索引 `/tmp/notalone09-validation-resource-index.json` 保存原失败和每轮分母；共23个守卫轮，62个唯一created库有逐名DROP与absence，另页面1库独立核销，不混入62。merger只读逐条核对日志SHA、保存的ownership／absence和62个唯一身份；7个实际执行守卫版本均按原SHA私有保留于 `/tmp/notalone09-preserved-guard-index.json`，不存在未恢复版本。planned记录0600／fsync、双URL导入前绑定、failfast／poison及封闭调用范围是本批边界，不是对任意未来PG客户端的全局保证。

[03默认库事故](reports/test-database-isolation-incident.md)的152项／65错误／1跳过及实际库身份／影响未知、[35个旧目录](reports/fixture-ownership-evidence-gap.md)归属已恢复但旧DB UUID仍0、[07／08旧嵌套CREATE](reports/nested-database-ownership-followups.md)各四个未记录UUID继续保留。09新资源核销不补证这些旧缺口；没有连接、扫描或清理未知库，不宣称其他会话完全未受影响。

## merger最小复验与当前状态

merger实际仅运行 `npm run typecheck`、工作树／暂存／3200至HEAD／M2至HEAD的 `git diff --check`，以及Node标准库固定Git与已存证据静态核对。结果均通过：001–064连续、旧63及M2旧58原字节、064固定SHA与task复合父键；十组原迁移门加learning新门和lifecycle054–064尾序；codec2/schema4八类型、两种冻结结构、500／三SQL范围／3-16-2048及三生产Grounded保持。11个保留合同源码与根3200逐字相同；静态未见09产品查询未来审核／政策表。没有启动数据库、HTTP、Chrome、App、微信、模型、探针或租约，没有新增动态成绩。

签收文件范围脚本首次在新报告暂存前执行，Git tracked diff尚不包含该文件，路径集合断言失败；原日志保留。把本票新报告正常纳入暂存后复验通过，没有改产品、放宽断言或新增动态运行。最终Markdown与11列TSV逐票核对为10／0／5及59／32，源S签收用issue-index.tsv原字节未改。

合并提交后实际执行 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree` 及 `--ref HEAD --working-tree`，两次issues0；只读main快照 `29e4f008446b9633580e4ffd746b5d6d74e581a1`，未吸收漂移。签收文档提交后继续执行同样两项检查。私有merger日志为 `/private/tmp/notalone-merge09-{typecheck,static-contract,publication-main,publication-head}.log`。

本票数据影响为显式授权经验的待审草稿、私人依据、材料消费与删除链；未迁移业务库。S分叉库保留，不合main、不push／PR或部署。签收后10 resolved（01–09、14）、0 claimed、5 open，AC59已勾／32未勾，10尚未领取；持续目标尚未完成。
