# 新真实聊天抽样结果

2026-10-14，本轮六窗全部完成，但质量未通过：4窗安全通过、1窗一般错误、1窗安全错误。已按末窗安全错误关闭场次；没有未跑窗口，没有修改生产放行表或写入业务记忆。

本轮遵循[冻结计划](core-new-real-sampling-plan-20261014.md)，从已授权的本机单联系人导出中选取6窗、16条必要文字，4窗主集、2窗留出，逐窗1个必需主张。属于目的性找错样本，不是全部聊天总体的随机准确率，也不是历史六窗的同批复测。来源与Gold先经独立审核再冻结；本轮没有调提示、换模型、重试或修改答案。

| 集合 | 已完成 | 必需正文raw | 必需accepted | 必需full | safe | general_error | safety_error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主集 | 4/4 | 4/4 | 3/4 | 3/4 | 3 | 1 | 0 |
| 留出 | 2/2 | 2/2 | 2/2 | 2/2 | 1 | 0 | 1 |
| 合计 | 6/6 | 6/6 | 5/6 | 5/6 | 4 | 1 | 1 |

raw表示提取到了正确核心正文；accepted表示复核后仍保留；full表示必需主张连同字段保留完整。full不是全窗安全通过：留出末窗的必需主张正确，但另有错误候选进入模拟auto。必需raw候选的14字段完整数为5/6；全体7个raw候选中5个字段完整，另外2个共4处字段错误。

发现的两个缺陷：

- W03：E保留了正确习惯正文，却误用recent_state及观察时间作为valid_at；V再把反问强调当成字面否定，以negation拒收，最终为空。正确核心正文损失1；由于E字段此前已错，完整合法候选误拒为0。封存审核中的positive_loss=1专指本轮核心正文损失，不能并入旧规格的完整正例保护指标。
- W06：必需短期计划与相对日期正确，另一个有据即时意向却被标成assertion，其interpretation_reason也将阶段解释为当前状态。V未指出这两项错误，额外候选最终进入模拟auto，错误auto=1。正文没有虚构已完成事件，因此不重复计作假事。该窗整体为safety_error，不能因必需full=1而算通过。

人工逐字段及来源核对，正文假事0、错人0、错误模拟auto1、语义审核unknown0。全体原始和最终候选均检查，包括有据额外候选；不是只检查必需主张。独立Agent复核全部六窗并同意上述结论。建议后续用合成回归分别修复反问的否定判断、习惯分类与时间，以及即时意向的阶段标注和V漏检；本次只测试和记录，未进行这些产品修复。

评测口径限制必须保留：旧通用case占位expect=pending导致W02/W04/W06的通用false_fact_count各1，总计3，旧通用passed仅2。冻结计划已声明该oracle不作私有语义成绩，因此原收据完整保留，独立评分另列，不能覆盖或直接引用旧汇总作结论。W02/W04模拟auto的正文和字段有据；W06模拟auto存在上述明确字段错误。模拟auto不经过生产维度放行验收，也没有实际写入。全部7个候选的程序proof仍为UNKNOWN（无业务来源绑定或不支持该证明范围），人工语义审核不将其升级为程序证明。生产默认维度放行保持空。

实际执行：官方deepseek-flash，thinking enabled、reasoning_effort=max，E/V均省略tool_choice但校验唯一具名工具；6次E加6次V，12/12请求均HTTP200，0重试、0fallback。预算已CLOSED，72条事件，capture_gaps=0，记录/收据/清理错误均无，进程已退出；stop为case_semantic_audit_safety_error，plan_complete=true，quality_certified=false。最后一窗触发安全停止时六窗已全部审完，unrun=0。

总执行约49.5分钟（包含逐阶段人工审核）；HTTP单次约33.48—486.75秒。配置timeout=300是网络读取超时，不保证单次总耗时不超过300秒；本轮另有冻结的绝对截止保护，实际在截止前收尾。此次耗时不能作为实时产品体验达标证据。

运行标识为70228a53-bed7-42ad-ad9e-28f28faf4423。新激活摘要3c49be52582bacf703bbea75d8678b0be640e92ce79b41596abd4552c6605d6d。运行前后源码、样本及Gold摘要一致。原文、导出身份、行号、Gold、适配器响应和审计仅保留于仓库外私有目录；本报告不包含这些材料。私有目录0700、文件0600；只有选中最小窗口及对应候选按授权发送到官方模型，未读取微信界面、启动真实App、导入业务库、修改同步水位或发送消息。

本地验证与运行命令（均在Conda NotAlone环境）：

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s desktop/artifacts/core-new-real-prepare-20261014 -p 'test_*.py'
NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 python desktop/artifacts/core-new-real-prepare-20261014/private_run.py prepare
NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 LANGSMITH_TRACING=false python desktop/artifacts/core-new-real-prepare-20261014/private_run.py run 3c49be52582bacf703bbea75d8678b0be640e92ce79b41596abd4552c6605d6d
node scripts/check_public_history.mjs --ref main --working-tree
```

运行前6项私有接线合成测试通过，包含无DNS/真实SDK模拟链路、显式审核、未知不得被safe覆盖、start写失败仍闭账；2份Python文件AST检查通过。收尾核验72条事件连续序号及逐条payload摘要、12组HTTP200、CLOSED12、六份评分计数和私有权限/摘要均通过，git diff --check无问题。Standards及Spec对接线和结果报告的复核均无阻塞。私有接线是本次受控诊断产物，保留在忽略目录，不强行提交，不是新的生产测试入口。公开历史检查在计划提交后为0问题，结果提交后另核。

本轮完成的是新抽样主集与新留出回放。原历史私有窗口未恢复，旧6/12、2/6成绩不改写；公开140例的既有安全停止及未跑部分也不因本轮完成而关闭。核心事实保真问题仍待修复和新的受控回归，不能将本报告当作整体问题已解决或生产自动采纳验收。
