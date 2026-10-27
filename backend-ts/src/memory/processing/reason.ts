/** 只映射已知安全类别；任意异常原文和技术编号不得进入主卡。 */
export function processingReason(code:string|null):string {
 if(['source_unavailable','extraction_sources_changed','extraction_sources_unavailable','extraction_task_sources_changed','trace_sources_unavailable'].includes(code??''))
  return '来源资料已失效或授权已撤销，请先核对资料范围。';
 if(['model_call_outcome_unknown','extraction_batch_outcome_unknown','extraction_model_ack_unknown','model_accounting_recovery_unavailable','processing_outcome_unknown'].includes(code??''))
  return '上次模型调用结果尚待核对，请先确认原调用回执，避免重复处理。';
 if(['model_configuration_unavailable','extraction_runtime_schema_unavailable','extraction_runtime_rule_unavailable','extraction_policy_source_unavailable','extraction_batch_configuration_invalid','extraction_task_runner_configuration_invalid'].includes(code??''))
  return '所需模型配置或运行资源不可用，请先修复配置后刷新状态。';
 if(['verification_contract_invalid','evidence_source_refs_duplicate','body_source_mismatch','deepseek_strict_schema_invalid'].includes(code??''))
  return '资料核验或处理协议未通过，请先检查并修复程序或资料依据。';
 if(['model_call_budget_exhausted','model_budget_exhausted','extraction_model_budget_exceeded','extraction_model_budget_unavailable','profile_input_budget_exceeded'].includes(code??''))
  return '本轮处理预算已用尽或暂不可用，请先查看处理详情与预算限制。';
 return '部分资料尚未完成处理，请查看原因并先修复阻碍。';
}
