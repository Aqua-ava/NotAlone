/** 仅生成合成请求及响应尺寸；不构造供应商客户端，不读环境/业务库，不发外呼。 */
import {writeFile} from 'node:fs/promises';
import {prepareSourceVerification} from '../../../../backend-ts/src/complete-claim-verification.ts';
import {parseDirectExtraction} from '../../../../backend-ts/src/extraction-protocol.ts';
import {createExtractionPolicyVersion} from '../../../../backend-ts/src/extraction-policy-version.ts';
import {resolveHostReplyConfiguration} from '../../../../backend-ts/src/host-reply-config.ts';
import {buildDeepSeekStrictVerificationRequest} from '../../../../backend-ts/src/deepseek-strict-verification.ts';
import {measureSerializedStrictChatCompletion} from '../../../../backend-ts/src/model-input-budget.ts';

const resolved=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-offline-no-network-key'});
if(resolved.status!=='configured')throw new Error('synthetic_configuration_unavailable');
const {budgetProfile:profile,...model}=resolved.model;
const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,temperature:model.temperature,reasoningEffort:model.reasoningEffort};
const identity=await createExtractionPolicyVersion(),sourceStamp=identity.sourceStamp;
const policy=identity.resolve(identity.newTaskConfig()).verification;
const owner_id='11111111-1111-4111-8111-111111111111',contact_id='22222222-2222-4222-8222-222222222222';
const message_id='33333333-3333-4333-8333-333333333333';
const cases=[];
for(const [name,count,quoteLength,partsCount,sourceCount=1] of [
 ['one_short',1,32,1],['four_short',4,32,1],['six_short',6,32,1],['sixty_short',60,32,1],
 ['one_full_quote',1,8192,1],['sixty_full_quote',60,8192,4],
 ['max_window_preflight',60,8192,4,60],
]){
 const source='甲'.repeat(quoteLength),ids=Array.from({length:sourceCount},(_,index)=>index===0?message_id:
  `33333333-3333-4333-8333-${String(index).padStart(12,'0')}`);
 const window={owner_id,contact_id,target_message_ids:ids.slice(0,20),messages:ids.map(id=>({
  message_id:id,sender:'contact',occurred_at:null,text:source,text_representation:'text',
 }))};
 const raw=Array.from({length:count},(_,index)=>({text:`合成候选编号${index}的完整正文`,category:'common_fact',subject:'contact',topic:'other',
  source_message_ids:ids,confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',
  figurative_type:'literal',alternatives:[],interpretation_reason:'仅测量协议尺寸，不对该例作语义合格声明。',event:null,conditions:null}));
 const facts=parseDirectExtraction({scenes:[{scene_name:'仅测尺寸',memories:raw}]},window).accepted;
 const prepared=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}});
 const request=buildDeepSeekStrictVerificationRequest({...binding,system:prepared.request.system,user:prepared.request.user,tool:prepared.request.tool});
 let input;
 try{input=measureSerializedStrictChatCompletion(request.body,binding,profile);}
 catch(error){
  if(error.code!=='reply_budget_exceeded')throw error;
  cases.push({name,candidate_count:count,source_message_count:sourceCount,evidence_quote_codepoints:quoteLength,
   strict_schema_compiled:true,input_budget_passes:false,preflight_error:error.code,
   input_approximate_tokens:error.receipt.input_tokens,input_serialized_bytes:error.receipt.serialized_bytes,
   output_actual_token_count:null,model_not_invoked:true});continue;
 }
 const facet={verdict:'supported',evidence_indices:[0]};
 const output={request_fingerprint:prepared.fingerprint,results:raw.map((fact,candidate_index)=>({candidate_index,verdict:'supported',issues:[],
  evidence:[{message_id,quote:source}],claim_check:{version:1,parts:Array.from({length:partsCount},(_,index)=>({
   candidate_span:{start:Math.floor([...fact.text].length*index/partsCount),end:Math.floor([...fact.text].length*(index+1)/partsCount)},
   attribution:{...facet,scope_subject:'contact',actor_kind:'contact',resolution:'explicit'},
   arguments_and_relation:facet,temporal_and_modality:facet,
  }))}}))};
 const outputBytes=Buffer.byteLength(JSON.stringify(output),'utf8');
 cases.push({name,candidate_count:count,source_message_count:sourceCount,evidence_quote_codepoints:quoteLength,parts_per_candidate:partsCount,
  strict_schema_compiled:true,input_budget_passes:true,input_approximate_tokens:input.input_tokens,
  input_serialized_bytes:input.serialized_bytes,output_json_utf8_bytes:outputBytes,
  output_conservative_byte_proxy_fits:outputBytes<=binding.maxTokens,
  output_actual_token_count:null});
}
await identity.assertCurrent();
const report={version:1,kind:'synthetic_offline_budget_feasibility',source_stamp:sourceStamp,
 real_model_calls:0,reads_real_samples:false,binding,profile,calls_plan:{extraction:1,verification:1,additional_semantic_model:0},
 existing_live_ledger:'未读取、重置、延长或消费；本报告不能授予外呼资格',
 output_measurement:'UTF-8字节保守代理，与既有输入估算口径一致；没有供应商实际tokenizer，失败表示无法在4096内证明可行，不代表精确token数。',
 full_legal_range_proven:false,default_enabled:false,cases,
 conclusion:'小型短引文响应通过保守尺寸检查；协议允许的候选数和长引文上界不通过，最大窗口被既有输入门提前拒绝。不得据此扩大4096、calls/tokens门禁、增加V次数或截断；真实试跑另由协调会话独立决定。'};
const output=JSON.stringify(report,null,2)+'\n';
if(process.argv[2])await writeFile(process.argv[2],output);else process.stdout.write(output);
