# 联合候选 a61a2140 的非回复最小切片

2026-10-25。新臂固定 `a61a21407c9395c462e4e68bfeee4628e7e9b15c`，旧臂仍为 `3c168296e9e8edaa43b8b323ff693e790e709069`。使用只读 Git archive、现有锁定依赖和原样runner；未修改任何假响应、生产源码、任务状态或263证据。

| 域／冻结case | 逻辑运行 | 业务成功 | 已计划但本轮未执行 |
| --- | --- | --- | --- |
| 提取／`明确事实` | 1×3×双臂＝6 | 6 | 834／840 |
| L2／`l2_scenario-01` | 6 | 6 | 66／72 |
| L3／`l3_profile-01` | 6 | 6 | 66／72 |
| 学习／`skill_learning-01` | 6 | 6 | 66／72 |

24/24业务终态成功，51次本机假 provider HTTP，持久计数全部匹配；失败0、取消0、物理数未知0、硬断言失败0、执行／清理异常0。真实模型调用为0，没有假 provider 适配失败。本轮仅新增这24条，不扩大为合成全量或真实矩阵。

[完整摘要](report.json)仍保留非回复1056分母（24记录／1032未执行）和总1152分母（24记录／1128未执行），`overall=undetermined`、`real_model_quality_verified=false`、`production_switch_approved=false`。费用仅`waived_temporarily_by_user`，不是测量通过。原120资格仍单列，未改分母或门槛。

这里只确认该版本经现有正式来源／任务／PG及官方DSH profile的最小合同。提取假输出为空，strict-V及非空B／腾讯去重没有因此获得正向覆盖；旧整理no_change与新整理逐字回显不能作为同语义质量对照。来源角色／as_of／既有版本映射、取消迟到、完整E/V盲化及语义评分等原缺口继续存在。新盲包24条／12对只用于后续独立审阅准备，已完成语义审阅仍为0。

`a61a2140`已新增统一诊断预算模块与发送前接线，原263单窗口备忘录中关于“当时没有该接缝”的判断不能直接套到新版本。本轮profile未传真实ProblemBudget配置，未新建或消费真实账本；它不证明八次上限、SQLite累计预留、耗尽或unknown恢复专项已经通过。

原263召回／向量文件、推理及小集证据全部保留，未重跑109／140。追加的[来源等价证明](retrieval-source-equivalence.json)核对结果是45/46文件逐字相同、两个锁文件相同；唯一变化是`reply-evidence-alias.ts`增加`discussion_input`枚举。源图内两条入边分别为`reply-context-scenario.ts:8`、`reply-history.ts:7`的显式`import type`，不构成运行时依赖。冻结109走`overview:false`＋`reply_to_message`，140走embedding／hybrid，不经过讨论序列化。故可按此静态模块证明保留263的327／420兼容依据，不能称作a61新推理；本轮没有重哈希本机权重，复用仍以原权重／词表／配置不变为前提。

实际命令在上述SHA的只读源码副本执行；源码副本内放入最终manifest列出的原样runner，`GIT_OPTIONAL_LOCKS=0`且只读原对象库，没有checkout、暂存或提交。示意入口如下，输出目录须为新目录：

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"
node .scratch/dsh-ts-migration/resumed-nonreply-evaluation/runner.mjs fake \
  --new-commit a61a21407c9395c462e4e68bfeee4628e7e9b15c \
  --case-ids '["明确事实","l2_scenario-01","l3_profile-01","skill_learning-01"]' \
  --output-directory .scratch/dsh-ts-migration/resumed-nonreply-evaluation/NEW-A61-RUN \
  --private-output-directory "$HOME/.codex/private-diagnostics/NEW-A61-RUN"
```

原始journal、模型结果、盲包、绑定和日志留仓库外0700／0600目录，仓库仅摘要与哈希。源码／运行／清理摘要见`verification.json`；供根统一提交的完整文件清单与哈希见`final-manifest.json`。未操作App、微信、真实业务库或用户模型配置，未真实调用、未Git操作、未push／PR／打包。
