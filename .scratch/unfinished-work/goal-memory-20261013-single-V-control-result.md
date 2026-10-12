# 单次公开A02核验控制结果（2026-10-13）

本次唯一新V控制实际完成，四字段4/4与语义支持通过显式Agent审核；只证明这份原E14固定输入在本次新V提示调用中的结果。原86b A02的uncertain/pragmatics、full0与所有旧sealed保持，不签E提示收益、全21／140质量、维度放行或原验收票完成。原[预注册](goal-memory-20261013-single-V-control-plan.md)保留，Root已独立提交 `dfb7bbc6`，没有改写为结果。

Root于台北06:37:04再次冻结确认并授权唯一executor，额外要求首次dispatch早于06:43:35；原07:00绝对截止、cap1、300秒／0重试、API墙钟340秒与600秒审核保持。只运行新UUID `472f5c0d-7a7e-4620-9586-1698f76b7d97`，sole exec session86287，命令exit0；驱动单调时长79.530892167秒，正式审核阶段单调64.093968125秒（UTC22:37:48.260353至22:38:52.354322），小于600秒。未单独测量HTTP网络耗时，不能把驱动或两者差值当模型网络时长。

实际持久预约1／cap1，provider_request1、HTTP200 response1，九个stage累计真实HTTP43次＝39次200＋四次旧ReadTimeout远端结果未知。请求仍ecnu-max、thinking enabled；本次服务报告alias为deepseek-v4-flash，不能据alias证明权重相同或供应商因果修复。没有E调用、SDK retry、fallback或第二请求；最后reserve1用完，全量280尚未激活，已closed未用145与永久退役12不能复用。

## 实际V与原判据

固定公开A02的旧E14、window、两条source顺序、subject/contact、relationship_note、report/reported及双null原样保存；仅V system prompt换成已提交4c939d96，实际request body规范SHA与冻结 `2b700cfa3816174f87223b6058c489a3891bf9d16129293b3c053b03f09cbda4` 完全相同。

返回仅一条candidate_index0，verdict supported、issues空数组。两条evidence分别引用候选原source中的context0与target1，逐字片段均与原消息相同，包含真实target。语义上相连问答为老李向联系人提出周末钓鱼邀约；候选保存邀约转述，不补联系人接受、双方约定、活动已经发生、具体日期或地点，正合原A02-P1-v2。未来活动内容不改变已发生邀约的report/reported分支；双null没有把周末活动期间填成收到邀约的发生日期。身份恢复所依赖context也在原候选source中，没有V代补来源。

Agent实际逐项提交candidate_index、verdict、issues、evidence各pass及semantic_support pass，view规范SHA `2244344c46bc38c60363819ed8c773243326eafae8fdc873c098c54f49717181`；无默认pass、无思考读取或回填旧review。这次supported与旧相同输入的V失败可历史并列观察，单次非随机控制不能证明提示修改的稳定因果收益，更不能代表其他窗口。

## 终态与清理

completion真实closed1／reserved1／limit1，plan_complete=true只表示本次单项控制完整；quality_certified=false。六份持久事件、capture_gaps空、stopped_code null，client／记录／收据／cleanup错误均无。独立只读SQLite mode=ro再次核state.closed1和requests1；原in-flight.lock以O_RDONLY获得LOCK_EX|NB并释放，持久文件保留。

sole session86287确认本机评测入口exit0；精确python脚本与bundle参数的进程查询无匹配。原driver没有记录ownedPID，收据诚实标null，不能补造PID或宣称全进程覆盖／远端模型已退出。60源码在收口时均与首发冻结及4c939d96字节相同；没有后续模型请求、App／桌面／真实聊天／业务库操作。所有私有证据保留0700目录／0600文件，未删除预算或失败记录。

Root进一步独立核九个SQLite全closed共43、60当前源码与4c blobs一致、lock无持有、精确入口无进程，保存 `root-V-semantic-terminal-independent-check.json`（SHA `d76365ec2608e8d16f1d1f0065c335cd471500759e624470496335cc8683ce84`），随后明确解除源码／Git冻结。只允许下一步全140最小工具片与source-only119参考装配；没有授权新registry／HTTP。

证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`：`v-semantic-control/{run-result,run-summary,completion,manifest}.json`、六份event、V-semantic view／review／clock；`v-semantic-control-terminal-derived.json` SHA `690e6dbcec3a03279a41042a510a9c9226e57a7f757d515edab4fc970eccd2f8`，collector SHA `811c79388f5c8df4988e5162b15f170c61deb93fa5ed1382131d3a59f5e7658a`。completion文件SHA `458345fff02cfa521de1aa899aa5236a048795d2b57887cecb4a32a6f9c30127`，summary `9ca52be07e12d9df89d8e8beafb84c512b6f766c209df2064737d3f04595da1d`，result `ce3c580653978ad85e20d969e0b6f2d9d57b870b895420078d72e70136600b1a`。分别为文件SHA，不能混作规范对象摘要。

下一步沿[全140固定入口设计](goal-memory-20261013-full140-interface-design.md)，先红绿实现ecnu／reference／phased三个Module及既有三组测试，默认21与最多4诊断保持，未完整119参考必须在注册／credential前拒绝。原Gold21／oracle／safe-only／门槛／默认空放行表不变；119的七个source冲突继续集中独审，不作为外部阻塞或填有利答案。
