/**
 * 删除身份哈希特征用例：按调用点分组固定输入。
 * 期望值由生成器（一次性脚本）按当次实现的输出写入同目录 expected-hexes.mjs；
 * 重构收敛期间该期望文件一字不改，特征测试靠它与实现逐字节对比。
 * 注意：键值对形状的调用点（extraction/documents/management）真实键集合是
 * 本域 rowKinds 的固定 ASCII 列名；这里的固定输入不固化非 ASCII 键在该处的
 * 排序特征，排序统一结论由各调用点注释与测试矩阵另行核验。
 */
export const cases = [
  // —— history.rowIdentity：[kind, [k,v] 对数组]，default sort——
  {id:'hr-message-natural', fd:'history.rowIdentity', kind:'hex', args:['message',{owner_id:'00000000-0000-4000-8000-000000000002',id:'11111111-1111-4111-8111-111111111111'}]},
  {id:'hr-message-reversed', fd:'history.rowIdentity', kind:'hex', args:['message',{id:'11111111-1111-4111-8111-111111111111',owner_id:'00000000-0000-4000-8000-000000000002'}]},
  {id:'hr-history-quote-cjk-value', fd:'history.rowIdentity', kind:'hex', args:['history_quote',{owner_id:'00000000-0000-4000-8000-000000000003',id:'聊天-甲-001'}]},
  {id:'hr-source-proof-reversed', fd:'history.rowIdentity', kind:'hex', args:['source_proof',{contact_id:'c-001',owner_id:'o-002'}]},
  {id:'hr-empty-key', fd:'history.rowIdentity', kind:'hex', args:['message',{}]},
  {id:'hr-non-ascii-key', fd:'history.rowIdentity', kind:'hex', args:['message',{'甲':'一','owner_id':'o-005','é':'2','id':'3'}]},
  {id:'hr-undefined-value', fd:'history.rowIdentity', kind:'hex', args:['message',{owner_id:'o-006',id:undefined}]},
  {id:'hr-special-chars-value', fd:'history.rowIdentity', kind:'hex', args:['message',{owner_id:'a"b\nc\\dé',id:'🎉🇨🇳'}]},
  // —— extraction.address：[kind, [k,v]]，localeCompare——键集合为本域 rowKinds 固定 ASCII 列名
  {id:'ea-event_source-natural', fd:'extraction.address', kind:'hex', args:['event_source',{owner_id:'o-1',event_id:'e-2',record_id:'r-3'}]},
  {id:'ea-event_source-reversed', fd:'extraction.address', kind:'hex', args:['event_source',{record_id:'r-3',event_id:'e-2',owner_id:'o-1'}]},
  {id:'ea-operation_scope-natural', fd:'extraction.address', kind:'hex', args:['operation_scope',{owner_id:'o-1',operation_id:'op-2',source_contact_id:'c-3',effect_kind:'contact'}]},
  {id:'ea-operation_scope-reversed', fd:'extraction.address', kind:'hex', args:['operation_scope',{effect_kind:'contact',source_contact_id:'c-3',operation_id:'op-2',owner_id:'o-1'}]},
  {id:'ea-run_input', fd:'extraction.address', kind:'hex', args:['run_input',{owner_id:'o-1',run_id:'r-9',input_no:'0'}]},
  {id:'ea-model_call', fd:'extraction.address', kind:'hex', args:['model_call',{owner_id:'o-1',id:'call-7'}]},
  {id:'ea-processing_task', fd:'extraction.address', kind:'hex', args:['processing_task',{owner_id:'o-1',id:'task-4'}]},
  {id:'ea-task_contribution', fd:'extraction.address', kind:'hex', args:['task_contribution',{owner_id:'o-1',task_id:'t-8',source_contact_id:'c-3'}]},
  {id:'ea-step_input', fd:'extraction.address', kind:'hex', args:['step_input',{owner_id:'o-1',step_id:'s-6',input_no:'1'}]},
  {id:'ea-execution_input', fd:'extraction.address', kind:'hex', args:['execution_input',{owner_id:'o-1',event_id:'e-2',input_no:'2'}]},
  {id:'ea-execution_event', fd:'extraction.address', kind:'hex', args:['execution_event',{owner_id:'o-1',id:'ev-5'}]},
  {id:'ea-operation_item', fd:'extraction.address', kind:'hex', args:['operation_item',{owner_id:'o-1',operation_id:'op-2',item_id:'i-4',effect_kind:'message'}]},
  {id:'ea-model_operation', fd:'extraction.address', kind:'hex', args:['model_operation',{owner_id:'o-1',id:'op-2'}]},
  {id:'ea-step_attempt', fd:'extraction.address', kind:'hex', args:['step_attempt',{owner_id:'o-1',id:'a-3'}]},
  {id:'ea-processing_step', fd:'extraction.address', kind:'hex', args:['processing_step',{owner_id:'o-1',id:'st-2'}]},
  {id:'ea-processing_item', fd:'extraction.address', kind:'hex', args:['processing_item',{owner_id:'o-1',id:'it-1'}]},
  {id:'ea-processing_run', fd:'extraction.address', kind:'hex', args:['processing_run',{owner_id:'o-1',id:'run-1'}]},
  {id:'ea-run_contact', fd:'extraction.address', kind:'hex', args:['run_contact',{owner_id:'o-1',run_id:'r-9',contact_id:'c-3'}]},
  {id:'ea-event_source-cjk-value', fd:'extraction.address', kind:'hex', args:['event_source',{owner_id:'o-清理',event_id:'事件-乙',record_id:'r-中'}]},
  {id:'ea-empty', fd:'extraction.address', kind:'hex', args:['model_call',{}]},
  {id:'ea-special-value', fd:'extraction.address', kind:'hex', args:['step_input',{owner_id:'a"b',step_id:'c\\d',input_no:'{}'}]},
  // —— documents.identity：[domain, kind, [k,v]]，localeCompare——键集合为本域 rowKinds 固定 ASCII 列名
  {id:'di-document-version-natural', fd:'documents.identity', kind:'hex', args:['memory_document_version',{owner_id:'o-1',document_id:'d-2',version_no:'7'}]},
  {id:'di-document-version-rotated', fd:'documents.identity', kind:'hex', args:['memory_document_version',{document_id:'d-2',version_no:'7',owner_id:'o-1'}]},
  {id:'di-later-run-requirement', fd:'documents.identity', kind:'hex', args:['memory_document_later_run_requirement',{owner_id:'o-1',run_id:'r-9',scope_key:'私聊-会话'}]},
  {id:'di-later-cursor', fd:'documents.identity', kind:'hex', args:['memory_document_later_cursor',{owner_id:'o-1',scope_key:'sk-9'}]},
  {id:'di-later-schedule', fd:'documents.identity', kind:'hex', args:['memory_document_later_schedule',{owner_id:'o-1',scope_key:'sk-9',generation:'g-3'}]},
  {id:'di-processing-step', fd:'documents.identity', kind:'hex', args:['processing_step',{owner_id:'o-1',id:'ps-1'}]},
  {id:'di-publication', fd:'documents.identity', kind:'hex', args:['document_publication',{owner_id:'o-1',id:'pub-2'}]},
  {id:'di-document', fd:'documents.identity', kind:'hex', args:['memory_document',{owner_id:'o-1',id:'d-2'}]},
  {id:'di-empty', fd:'documents.identity', kind:'hex', args:['memory_document',{}]},
  {id:'di-cjk-values', fd:'documents.identity', kind:'hex', args:['memory_document',{owner_id:'甲-乙',id:'文档-1'}]},
  {id:'di-special-value', fd:'documents.identity', kind:'hex', args:['memory_document_version',{owner_id:'a\\b"',document_id:'版本\n三',version_no:'0'}]},
  // —— management.identity：[domain, kind, [k,v]]，localeCompare——键集合为本域 rowKinds 固定 ASCII 列名
  {id:'mi-memory-version-natural', fd:'management.identity', kind:'hex', args:['memory_version',{owner_id:'o-1',memory_id:'m-2',version_no:'3'}]},
  {id:'mi-memory-version-rotated', fd:'management.identity', kind:'hex', args:['memory_version',{memory_id:'m-2',version_no:'3',owner_id:'o-1'}]},
  {id:'mi-candidate', fd:'management.identity', kind:'hex', args:['memory_candidate',{owner_id:'o-1',id:'cd-5'}]},
  {id:'mi-memory', fd:'management.identity', kind:'hex', args:['memory',{owner_id:'o-1',id:'m-2'}]},
  {id:'mi-decision', fd:'management.identity', kind:'hex', args:['memory_decision',{owner_id:'o-1',id:'de-1'}]},
  {id:'mi-empty', fd:'management.identity', kind:'hex', args:['memory',{}]},
  {id:'mi-cjk-values', fd:'management.identity', kind:'hex', args:['memory',{owner_id:'甲',id:'记忆-中'}]},
  // —— media.identity：canonical([kind, key 对象])，递归对象键码点序——
  {id:'md-message-media-natural', fd:'media.identity', kind:'hex', args:['message_media',{owner_id:'o-1',message_id:'m-中'}]},
  {id:'md-message-media-reversed', fd:'media.identity', kind:'hex', args:['message_media',{message_id:'m-中',owner_id:'o-1'}]},
  {id:'md-media-file', fd:'media.identity', kind:'hex', args:['media_file',{owner_id:'o-3',id:'f-2'}]},
  {id:'md-extraction-attempt-reversed', fd:'media.identity', kind:'hex', args:['media_extraction_attempt',{id:'a-1',owner_id:'o-4'}]},
  {id:'md-empty-key', fd:'media.identity', kind:'hex', args:['media_file',{}]},
  {id:'md-cjk-values', fd:'media.identity', kind:'hex', args:['message_media',{owner_id:'甲',message_id:'消息-1'}]},
  // —— media.canonical：递归排序键的 JSON 文本——
  {id:'mr-object-abstract', fd:'media.canonical', kind:'text', args:[{b:1,a:2}]},
  {id:'mr-object-alternate', fd:'media.canonical', kind:'text', args:[{a:2,b:1}]},
  {id:'mr-nested', fd:'media.canonical', kind:'text', args:[{name:'资料',meta:{c:1,b:{'别名':'中国国际调查'}}}]},
  {id:'mr-array-of-objects', fd:'media.canonical', kind:'text', args:[[{z:null,y:undefined},{m:'中'}]]},
  {id:'mr-non-ascii-keys', fd:'media.canonical', kind:'text', args:[{'é':'1','甲':2,'A':3,'b':4,'🎉':'9'}]},
  {id:'mr-literal-types', fd:'media.canonical', kind:'text', args:[[null,true,0,'','text']]},
  {id:'mr-empty-objects', fd:'media.canonical', kind:'text', args:[[{},[]]]},
  {id:'mr-array-order-preserved', fd:'media.canonical', kind:'text', args:[[2,1,'b','a']]},
  // —— reply.canonical：与 media 同实现的独立副本——
  {id:'rc-object-abstract', fd:'reply.canonical', kind:'text', args:[{站点:'备份',b:[3,1],a:false}]},
  {id:'rc-nested-arrays', fd:'reply.canonical', kind:'text', args:[{x:[{q:'问',a:'答',y:[1,2,3]},{单:'字'}]}]},
  // —— reply.hash：canonical(value)+sha256——
  {id:'rh-lease-token', fd:'reply.hash', kind:'hex', args:[['op-123','req-456']]},
  {id:'rh-row-identity', fd:'reply.hash', kind:'hex', args:[['owner-1','op-9','discussion_content','d-77']]},
  {id:'rh-cjk-copy', fd:'reply.hash', kind:'hex', args:[['owner-中','op-1','reply_context','上下文-1']]},
  {id:'rh-address-shape', fd:'reply.hash', kind:'hex', args:[{b:'地址',a:'甲'}]},
  {id:'rh-holder-empty-array', fd:'reply.hash', kind:'hex', args:[[[{k:'运行时',j:0}],{}]]},
  {id:'rh-empty-arrays', fd:'reply.hash', kind:'hex', args:[[[],{}]]},
  // —— calls.identity：discussion_calls，[kind, Object.entries(key).sort()]（pair join 默认序）——
  {id:'ca-event_source-natural', fd:'calls.identity', kind:'hex', args:['event_source',{owner_id:'o-1',event_id:'e-2',record_id:'r-3'}]},
  {id:'ca-event_source-reversed', fd:'calls.identity', kind:'hex', args:['event_source',{record_id:'r-3',event_id:'e-2',owner_id:'o-1'}]},
  {id:'ca-execution_input-natural', fd:'calls.identity', kind:'hex', args:['execution_input',{owner_id:'o-1',event_id:'e-2',input_no:'2'}]},
  {id:'ca-execution_input-rotated', fd:'calls.identity', kind:'hex', args:['execution_input',{input_no:'2',event_id:'e-2',owner_id:'o-1'}]},
  {id:'ca-operation_scope-natural', fd:'calls.identity', kind:'hex', args:['operation_scope',{owner_id:'o-1',operation_id:'op-2',source_contact_id:'c-3',effect_kind:'contact'}]},
  {id:'ca-operation_scope-reversed', fd:'calls.identity', kind:'hex', args:['operation_scope',{effect_kind:'contact',source_contact_id:'c-3',operation_id:'op-2',owner_id:'o-1'}]},
  {id:'ca-model_call', fd:'calls.identity', kind:'hex', args:['model_call',{owner_id:'o-1',id:'call-7'}]},
  {id:'ca-model_operation', fd:'calls.identity', kind:'hex', args:['model_operation',{owner_id:'o-1',id:'op-2'}]},
  {id:'ca-execution_event', fd:'calls.identity', kind:'hex', args:['execution_event',{owner_id:'o-1',id:'ev-5'}]},
  {id:'ca-cjk-value', fd:'calls.identity', kind:'hex', args:['model_call',{owner_id:'联系人-甲',id:'调用-9'}]},
  {id:'ca-empty', fd:'calls.identity', kind:'hex', args:['model_call',{}]},
  {id:'ca-special-value', fd:'calls.identity', kind:'hex', args:['event_source',{owner_id:'a"b',event_id:'c\\d',record_id:'{}'}]},
  // —— candidates.identity：[domain, ownerId, operationId, id] 纯数组——
  {id:'ci-standard', fd:'candidates.identity', kind:'hex', args:[{ownerId:'owner-1',operationId:'op-1'},'req-77']},
  {id:'ci-cjk', fd:'candidates.identity', kind:'hex', args:[{ownerId:'甲',operationId:'操作-1'},'请求-1']},
  {id:'ci-empty-strings', fd:'candidates.identity', kind:'hex', args:[{ownerId:'',operationId:''},'']},
  {id:'ci-special', fd:'candidates.identity', kind:'hex', args:[{ownerId:'a\\b"中',operationId:'op"},}'},'id🎉']},
];

/** 出现同键不同插入顺序的用例组：期望哈希必须相等（插入顺序不应影响身份）。 */
export const equivalentPairs = [
  ['hr-message-natural','hr-message-reversed'],
  ['ea-event_source-natural','ea-event_source-reversed'],
  ['ea-operation_scope-natural','ea-operation_scope-reversed'],
  ['di-document-version-natural','di-document-version-rotated'],
  ['mi-memory-version-natural','mi-memory-version-rotated'],
  ['md-message-media-natural','md-message-media-reversed'],
  ['mr-object-abstract','mr-object-alternate'],
  ['ca-event_source-natural','ca-event_source-reversed'],
  ['ca-execution_input-natural','ca-execution_input-rotated'],
  ['ca-operation_scope-natural','ca-operation_scope-reversed'],
];
