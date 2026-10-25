# 非回复域验收准备报告

2026-10-25。已交付冻结材料校验、1056条非回复成对计划、最小可执行假 provider runner、1152条统一报告装配及私有盲包生成。**真实模型调用为0，真实质量、正式费用和迁移切换均未签收。**

旧臂固定 `3c168296e9e8edaa43b8b323ff693e790e709069`；本次可执行证据的新臂固定 `263365556e9058b3fc7b1abbbdbe43b7f9a323d2`。根后续修改不自动继承此版本的验收；最终小集使用该提交的只读 Git archive、副本内的当前 runner 和既有锁定依赖，未 checkout、reset、暂存或提交。

| 范围 | 本轮真实执行结果 | 尚未执行／不能据此推导 |
| --- | --- | --- |
| 材料 | 56份文件及301例规范摘要全部核对；140提取、16回复、109召回、36工程例保留 | 未修改材料、作者预期或旧阈值；条件3／数量1的不足仍在 |
| 提取 | `明确事实`×3×双臂＝6逻辑运行，正式来源、A/B、trace、水位及持久计数 | 正式140×3×双臂840；假提取为空，V为零候选时不需要调用，不能宣称已覆盖真实提取／strict-V质量 |
| L2 | `l2_scenario-01`×3×双臂＝6逻辑运行，正式存储与TS官方profile | 正式72；删除／冲突／跨联系人／主体／修正全矩阵、真实模型及质量未执行 |
| L3 | `l3_profile-01`×3×双臂＝6逻辑运行，正式维护入口与新臂画像写入／核验 | 正式72；旧假提案允许no_change，不能据此声称两臂同语义输出或L3质量相等 |
| 学习 | `skill_learning-01`×3×双臂＝6逻辑运行，授权、租约、捕获、no_change保存与PG计数 | 正式72；现有启用版本绑定及真实草稿／审核未在冻结小集中覆盖 |
| 109召回 | 每臂327运行，327/327与固定旧合同逐项一致 | 等价不等于全部命中；旧改写类14/15命中原样保留 |
| 140向量 | 每臂420运行，420数值与排序通过，512维、token ids/mask一致；最大误差`1.1803593040482507e-7`＜`1e-5` | 仅本机向量兼容，不证明生成质量、DSH／HTTP／桌面完整链 |

小集24/24业务终态成功，51次本机假 provider HTTP，持久物理计数全部匹配、硬断言失败0；1056非回复分母仍有1032未执行。统一1152模型分母为24已记录、1128未执行，其中回复96由其他会话承接。[小集完整摘要](smoke-26336555/report.json)的结论为`undetermined`，不是通过。[召回／向量证据](current-retrieval/retrieval-results.json)绑定46份相关源码及锁文件，报告摘要`33886d4e…8b9e`。

两臂的本机假响应只用于各自结构、来源及事务合同，旧整理no_change与新整理逐字回显不能用于质量、延迟、token或费用比。报告明确保留配置／适配等价尚未建立，所有供应商usage、费用和真实模型fingerprint仍为unknown；人工或Agent语义评分为0。

旧整理在`3c168296`使用原`layered_memory_job.model_calls_used`逐HTTP持久预算，没有迁移后新增的共享ModelPermit／receipt模块；本轮按原预算与观测物理数核对，没有把新实现注入旧业务。新臂沿ModelPermit、outbound ledger及receipt审计；两种依据分别标注。

取消迟到三例及学习错主体例在当前冻结适配未完成时返回unknown、零发送；完整计划保留原事件、三重复及双臂，不把事件描述交给模型执行。其他未执行例也留在分母，失败、取消、缺失和未知不会被删除。旧0f78候选漂移拒绝及所有TDD失败保留为私有日志摘要，不改成成功记录。

原始结果、诊断日志、两份可见盲包及私有绑定只留仓库外0700／0600目录；仓库只留摘要、哈希和重建计划的逐次绑定。当前包为24条／12对，独立审阅完成0；仅持久业务投影的中性包已生成，完整提取和来源核验trace的中性规范化仍需补齐，不能据包生成宣称质量通过。

费用政策按[根范围更新](../acceptance-scope-update.md)记录`waived_temporarily_by_user`，不是费用测量达标；原记录保留。原120例正式资格单独列为未执行，不加入本次1056／1152分母，也不强制替代原规格。

DSH固定`0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`。已读锁定[启动架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#application-launch)、[LLM文档与示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#use-this-package)、[profile启动源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts)，并核对安装版本与现有宿主测试。新臂复用官方profile及现有业务装配，不修改DSH核心、不增加模型Tool。

可重现入口（从仓库根；须使用与显式pin一致的源码，或上述只读archive隔离副本）：

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"
node --test backend-ts/test/nonreply-comparison-plan.test.mjs backend-ts/test/nonreply-comparison-blind.test.mjs
NOTALONE_NONREPLY_CANDIDATE_COMMIT=263365556e9058b3fc7b1abbbdbe43b7f9a323d2 node --test .scratch/dsh-ts-migration/resumed-nonreply-evaluation/runtime.test.mjs
node .scratch/dsh-ts-migration/resumed-nonreply-evaluation/runner.mjs fake \
  --new-commit 263365556e9058b3fc7b1abbbdbe43b7f9a323d2 \
  --case-ids '["明确事实","l2_scenario-01","l3_profile-01","skill_learning-01"]' \
  --output-directory .scratch/dsh-ts-migration/resumed-nonreply-evaluation/NEW-RUN \
  --retrieval-report .scratch/dsh-ts-migration/resumed-nonreply-evaluation/current-retrieval/retrieval-results.json
```

`plan`命令零执行；`fake`只接本机替身。退出0仅表示装配完成，必须读报告状态和完整分母。可用`--reply-report`接既有`reply-migration-report-v1`报告；版本／材料不符时保留原报告但不计入当前完成数。重型runtime／retrieval验收测试留本目录显式运行，普通backend自动测试仅新增轻量plan／blind用例。

完整真实调用前，根仍需完成：固定最终源码与锁／profile／实际参数和提示／工具schema；补原窗口时间与来源角色、现有Skill／投影版本、取消迟到与修正映射；为每域先完成严格合同与独立语义输入审阅；把同问题累计物理cap接到实际发送前（含strict-V及B），再运行完整分母；保留失败与unknown并完成两名独立盲评及第三人裁决。既有回执未知不得新建task盲重放。[单窗口先审接缝证据](single-window-seam.md)单独说明A-only、审后B及八次cap的实际缺口。

数据影响：只读仓库／固定源码，写入独立随机`_test`库、合成profile和私有诊断目录；本轮未操作App、微信、真实库或用户模型配置，未建立真实预算、未调用真实模型、未发送外部消息、未Git暂存／提交、未push／PR／打包。源码与真实验收、最终审查和提交由根统一处理。

必要回归最终为轻量plan／blind **5/5**、263源码副本上的正式runtime **2/2**、完整召回／向量入口 **1/1**；语法检查通过，未运行backend全量。公开文件哈希、日志摘要及源码版本见 `verification.json`、`red-green-evidence.json`。

后续复用边界：召回／向量仅绑定结果中的46份相关源码及锁文件，哈希全部一致时可保留当前证据，不因纯文档、无关alias或提交元数据变化重复推理。改变召回过滤／评分／排序／上下文读取，须补109；改变权重／分词／归一化／embedding／融合，须补140。263的profile小集不能自动认证根的新版本；提取、来源、预算、租约、L2/L3、学习或其装配改变后先补对应最小切片及相关合同，再决定是否推进正式矩阵。腾讯源码集成后的生产行为必须另有新版本证据，不能继承本轮真假provider结果为真实质量。
