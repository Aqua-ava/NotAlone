// 仅生成设计清单与覆盖矩阵；不打开数据库、不产生迁移或修改业务代码。
import fs from 'node:fs';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname);
const baseline=JSON.parse(fs.readFileSync(path.join(root,'table-inventory.json'),'utf8'));
const legacy=JSON.parse(fs.readFileSync(path.join(root,'legacy-coverage.json'),'utf8'));
const traceInputs=['trace_message_input','trace_source_input','trace_memory_input','trace_document_input','trace_feedback_input'];
const sharedInputs=[...traceInputs,'assistant_context_snapshot','assistant_context_item','preference_version_source','organization_feedback_input','skill_learning_input','skill_review_input','overview_projection_member'];
const definitions={
  claim_evidence:{group:'记忆及证据',one_row_meaning:'候选或已采纳记忆版本的一处真实消息片段',primary_key_shape:'owner_id,evidence_id'},
  claim_required_message:{group:'记忆及证据',one_row_meaning:'一个主张成立必须存在的一条消息',primary_key_shape:'owner_id,requirement_id'},
  skill_operation:{group:'Skill及审核',one_row_meaning:'一次明确的Skill目录、政策或学习授权动作及幂等结果',primary_key_shape:'owner_id,operation_key'},
  deletion_target:{group:'读取及删除',one_row_meaning:'删除操作中一个具有明确存储类型及预期身份的清理目标',primary_key_shape:'operation_id,target_no'},
  read_exclusion:{group:'读取及删除',one_row_meaning:'一个会话、消息或捕获身份的最小读取排除',primary_key_shape:'owner_id,exclusion_id'},
  model_call_execution:{group:'处理与调用',one_row_meaning:'一次物理调用唯一对应的step/assistant/quality真实执行及调用槽',primary_key_shape:'owner_id,call_id'},
  scope_projection:{group:'派生文档与投影',one_row_meaning:'同范围某一类型导航/概览投影的当前元数据',primary_key_shape:'owner_id,projection_id'},
  material_set:{group:'共用材料',one_row_meaning:'某一明确用途、时点及业务归属的不可变材料清单/快照',primary_key_shape:'owner_id,material_set_id'},
  material_reference:{group:'共用材料',one_row_meaning:'材料清单中的一个有类型、有真实FK的来源或具体版本',primary_key_shape:'owner_id,material_set_id,item_no'},
  trace_input:{group:'记忆及证据',one_row_meaning:'一次memory_trace中的一个明确类型实际输入',primary_key_shape:'owner_id,trace_id,input_no'},
  manual_contact_confirmation:{group:'身份',one_row_meaning:'一次用户明确手动联系人确认，不授予微信读取资格',primary_key_shape:'owner_id,confirmation_id'},
  processing_operation:{group:'处理与调用',one_row_meaning:'一次start/pause/resume等处理控制动作的幂等回执',primary_key_shape:'owner_id,operation_key'},
  assistant_request_tombstone:{group:'助手与候选',one_row_meaning:'已删除或中断回复请求的最小封存键',primary_key_shape:'owner_id,contact_id,request_key'},
  database_instance:{group:'数据库元数据',one_row_meaning:'数据库实例UUID、用途和格式身份',primary_key_shape:'singleton_key=1'},
  schema_migration:{group:'数据库元数据',one_row_meaning:'新SQLite结构的一次已提交版本及校验和',primary_key_shape:'migration_no'}
};
const commonGroups=[
 ['claim_evidence',['candidate_evidence','memory_version_evidence']],
 ['claim_required_message',['candidate_required_message','memory_version_required_message']],
 ['skill_operation',['skill_policy_operation','skill_learning_operation','skill_catalog_operation']],
 ['deletion_target',['deletion_row_target','deletion_file_target']],
 ['read_exclusion',['ingestion_tombstone','conversation_exclusion']],
 ['model_call_execution',['step_model_call','assistant_attempt_model_call']],
 ['scope_projection',['overview_projection']]
];
const additions=['manual_contact_confirmation','processing_operation','assistant_request_tombstone','database_instance','schema_migration'];
function build(kind){
 const mapping=Object.fromEntries(baseline.tables.map(t=>[t.name,[t.name]]));
 const collapsed={};
 for(const [to,from]of commonGroups){collapsed[to]=from;for(const name of from)mapping[name]=[to];}
 mapping.skill_review_target=['skill_review','skill_draft_target'];
 const replaced=new Set(['skill_review_target']);
 for(const [,from]of commonGroups)for(const name of from)replaced.add(name);
 if(kind==='shared_materials'){
  for(const name of sharedInputs){replaced.add(name);mapping[name]=name==='assistant_context_snapshot'?['material_set']:['material_reference'];}
  collapsed.material_set=['assistant_context_snapshot'];
  collapsed.material_reference=sharedInputs.filter(n=>n!=='assistant_context_snapshot');
 }else{
  for(const name of traceInputs){replaced.add(name);mapping[name]=['trace_input'];}
  collapsed.trace_input=traceInputs;
 }
 const rows=baseline.tables.filter(t=>!replaced.has(t.name)).map(t=>({...t,logical_sources:[t.name]}));
 for(const [name,sources]of Object.entries(collapsed)){
  const sourceRows=baseline.tables.filter(t=>sources.includes(t.name));
  const status=sourceRows.every(t=>t.status==='conditional')?'conditional':'business';
  rows.push({name,...definitions[name],status,logical_sources:sources,source_tasks:[...new Set(sourceRows.flatMap(t=>t.source_tasks??[t.source_task]))]});
 }
 for(const name of additions)rows.push({name,...definitions[name],status:name==='database_instance'||name==='schema_migration'?'metadata':'business',logical_sources:[],source_tasks:['10']});
 rows.sort((a,b)=>a.group.localeCompare(b.group,'zh-Hans-CN')||a.name.localeCompare(b.name));
 if(new Set(rows.map(t=>t.name)).size!==rows.length)throw new Error('duplicate physical table');
 const counts={total:rows.length,business:0,conditional:0,diagnostic:0,metadata:0};
 for(const r of rows)counts[r.status]++;
 return {kind,counts,tables:rows,logical_to_physical:mapping,derived_relations:[{logical:'skill_review_target',via:['skill_review.draft_id/revision','skill_draft_target'],condition:'审核无独立targets输入；不可变草稿版本固定集合，发布仍核当前版本和来源'}]};
}
const shared=build('shared_materials'),domain=build('domain_inputs');
if(shared.counts.total!==94||domain.counts.total!==100)throw new Error('catalog count changed; inspect instead of silently publishing a target');
const catalog={schema_version:1,date:'2026-10-28',state:'historical_unapproved_superseded_by_requirements_audit',baseline:baseline.counts,recommended:null,requirement_gate:'用户未认可94表；先按真实需求逐表审查，再讨论Q43。旧PG只查漏，不是保留要求。',options:{shared_materials:shared,domain_inputs:domain},count_notes:[
 '94包括86基础业务、2项暂保留的条件投影、4项诊断能力、2项数据库元数据；不是94类产品功能。',
 '4项诊断没有擅自搬出业务库；同schema的隔离测试实例另设角色门禁，真实case仍按敏感数据清理。',
 '新增手动确认、处理控制回执及子回复封存键来自旧功能覆盖，不能为减表省略。',
 '学习材料单元由既有receipt真实引用material_set并保留batch/ordinal归属；若改成独立membership实现，需要再加表重算。',
 '不合并Skill与方法祖先两张图；不靠预期缓存性能删除暂保留项。',
 '清单与主外键概形不是已执行的全量DDL，Q43选择、各类型完整约束及接口改造尚待后续。'
]};
fs.writeFileSync(path.join(root,'physical-catalog.json'),JSON.stringify(catalog,null,2)+'\n');
const groups={};for(const t of shared.tables)(groups[t.group]??=[]).push(t);
let md='# 历史物理候选清单（未获认可）\n\n94表推荐已撤回，Q43暂缓。以下仅保留上一轮推导对照，当前入口为[按需求逐表审查](requirements-table-rationale.md)。旧PG仅查漏，不能要求照搬全部旧能力。\n\n';
md+='当前逻辑草案107项（100业务、3条件、4诊断），覆盖审计另补3个真实身份／操作／封存记录，再计2个数据库元数据。用途内收敛为100表；共享有类型材料清单方案为94表。\n\n';
md+='| 历史候选分类（未批准） | 数量 |\n| --- | ---: |\n';for(const k of ['business','conditional','diagnostic','metadata','total'])md+=`| ${k} | ${shared.counts[k]} |\n`;
md+='\n字段类型、FK分支、索引、用途隔离、运行时和切换门禁见[物理设计方案](physical-schema-plan.md)。原始清点见[逻辑清单](table-inventory.md)，旧表覆盖见[物理覆盖矩阵](physical-coverage.md)。\n\n';
let no=0;for(const [group,tables]of Object.entries(groups)){
 md+=`## ${group}（${tables.length}）\n\n| 序号 | 表 | 一行含义 | 主键概形 | 状态／来源 |\n| ---: | --- | --- | --- | --- |\n`;
 for(const t of tables){const from=t.source_file?`[${t.source_task}](issues/${path.basename(t.source_file)})`:'10／本文物理合并';md+=`| ${++no} | \`${t.name}\` | ${t.one_row_meaning} | ${t.primary_key_shape} | ${t.status}；${from} |\n`;}
 md+='\n';
}
md+='## 计数约束\n\n'+catalog.count_notes.map(x=>'- '+x).join('\n')+'\n';
fs.writeFileSync(path.join(root,'physical-table-catalog.md'),md);
const resolutions={
 manual_contact_confirmation:{targets:['manual_contact_confirmation'],kind:'补真实实体',note:'assistant_turn用真实manual_confirmation_id与binding_id排他，保留本次客户端确认代次。'},
 contact_memory_state:{targets:['processing_scope'],kind:'补集合字段',note:'稳定范围增加memory_revision；不是head_revision或document dirty_revision。'},
 owner_memory_state:{targets:['processing_scope'],kind:'补集合字段',note:'本人范围同样维护memory_revision，空集合也初始化。'},
 contact_memory_index:{targets:['scope_projection'],kind:'有类型投影',note:'projection_kind=contact_index，独立字段合同；不冒称等同long_term_overview。'},
 memory_processing_operation:{targets:['processing_operation'],kind:'补控制回执',note:'明确start/pause/resume幂等键与旧动作拒绝，不能只有run启动键。'},
 reply_invalidated_key:{targets:['assistant_request_tombstone'],kind:'补子请求封存',note:'与删除操作键不同；删除／中断后旧回复不能重建。'},
 wechat_sync_scope:{targets:['account_sync_control'],kind:'补范围字段',note:'scope_mode、scope_generation、明确授权版本／时间独立于read_enabled；默认仍按已确认所选范围，保留前台共同消费者。'},
 organization_quality_revocation:{targets:[],kind:'候选不建',note:'只见迁移定义、无src/test业务消费者；初始化结构检查随新schema改造，不能宣称已做运行验收。'}
};
const known=new Set(shared.tables.map(t=>t.name));
const coverage=legacy.tables.map(r=>{
 const res=resolutions[r.old_table];
 const targets=res?.targets??[...new Set((r.proposed_logical_targets??[]).flatMap(t=>shared.logical_to_physical[t]??[t]))];
 for(const t of targets)if(!known.has(t))throw new Error(`unlisted physical target ${r.old_table} -> ${t}`);
 return {...r,physical_plan_status:res?res.kind:r.status==='drop_legacy'?'按确认范围退役':r.status==='diagnostic_only'?'保留诊断能力，非默认测试库隔离事实':'已给映射，待实现验证',physical_targets:targets,physical_plan_note:res?.note??r.reason,verification_status:'static_mapping_only'};
});
if(coverage.length!==115||new Set(coverage.map(r=>r.old_table)).size!==115)throw new Error('legacy count mismatch');
const cov={schema_version:1,date:'2026-10-28',state:'historical_mapping_not_requirements_or_runtime_certification',source_summary:legacy.summary,summary:{old_tables:115,old_unmapped:8,unmapped_with_explicit_plan:8,remaining_without_plan:0,implementation_and_runtime_verified:0},tables:coverage,limits:legacy.limits};
fs.writeFileSync(path.join(root,'physical-coverage.json'),JSON.stringify(cov,null,2)+'\n');
let cm='# 历史覆盖矩阵（未批准）\n\n本表映射至上一轮94表候选，仅供旧PG查漏，不能作为新库保留需求或实现任务。当前见[按需求逐表审查](requirements-table-rationale.md)。\n\n静态CREATE/DROP重放，不是实际用户库元数据。115项均给出计划；本轮没有完成115项实现或运行验收。原8个缺口已补实体／字段／投影／候选退役方案。\n\n';
cm+='4张质量表保留真实消费者；只有createRun有既有_test门禁，不能宣称case均已隔离。移除旧文件导入／媒体／升级入口须同步退役API和恢复耦合。\n\n';
cm+='| 旧表 | 物理候选 | 计划状态 | 依据／范围 |\n| --- | --- | --- | --- |\n';
for(const r of coverage){const e=r.consumer_evidence?.[0];const ev=e?`；[代码](../../${e.file}#L${e.line})`:'';cm+=`| \`${r.old_table}\` | ${r.physical_targets.map(t=>'`'+t+'`').join('、')||'不建'} | ${r.physical_plan_status} | ${r.physical_plan_note.replaceAll('|','／')}${ev} |\n`;}
cm+='\n详细来源、原始分类和所有证据见[JSON矩阵](physical-coverage.json)；字段／门禁见[物理方案](physical-schema-plan.md)。\n';
fs.writeFileSync(path.join(root,'physical-coverage.md'),cm);
process.stdout.write(JSON.stringify({baseline:baseline.counts,shared:shared.counts,domain:domain.counts,old_coverage:cov.summary})+'\n');
