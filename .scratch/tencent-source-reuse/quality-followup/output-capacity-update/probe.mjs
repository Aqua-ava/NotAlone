/** 只测当前配置与合成小窗，保留原输入计量；不连接供应商或业务库。 */
import {writeFile} from 'node:fs/promises';
import {resolveHostReplyConfiguration} from '../../../../backend-ts/src/host-reply-config.ts';
import {createExtractionPolicyVersion} from '../../../../backend-ts/src/extraction-policy-version.ts';
import {parseDirectExtraction} from '../../../../backend-ts/src/extraction-protocol.ts';
import {prepareSourceVerification} from '../../../../backend-ts/src/complete-claim-verification.ts';
import {buildDeepSeekStrictVerificationRequest} from '../../../../backend-ts/src/deepseek-strict-verification.ts';
import {measureSerializedStrictChatCompletion} from '../../../../backend-ts/src/model-input-budget.ts';
const config=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-output-probe-key'});
if(config.status!=='configured')throw new Error('synthetic_configuration_failed');
const identity=await createExtractionPolicyVersion(),policy=identity.resolve(identity.newTaskConfig()).verification;
const {model}=config,binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,temperature:model.temperature,reasoningEffort:model.reasoningEffort};
const profile=model.budgetProfile,cases=[];
for(const [name,count,length] of [['one_short',1,32],['four_short',4,32],['one_long',1,8192],['four_long',4,8192]]){
 const messages=Array.from({length:count},(_,index)=>({message_id:`33333333-3333-4333-8333-${String(index).padStart(12,'0')}`,
  sender:'contact',occurred_at:null,text:'甲'.repeat(length),text_representation:'text'}));
 const window={owner_id:'11111111-1111-4111-8111-111111111111',contact_id:'22222222-2222-4222-8222-222222222222',
  target_message_ids:messages.map(message=>message.message_id),messages};
 const raw=messages.map((message,index)=>({text:`第${index}条完整合成候选`,subject:'contact',category:'common_fact',topic:'other',
  source_message_ids:[message.message_id],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',
  assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'仅测尺寸，不声明语义有据。',event:null,conditions:null}));
 const facts=parseDirectExtraction({scenes:[{scene_name:'合成尺寸探针',memories:raw}]},window).accepted;
 const prepared=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}}),request=prepared.request;
 const wire=buildDeepSeekStrictVerificationRequest({...binding,system:request.system,user:request.user,tool:request.tool});
 const receipt=measureSerializedStrictChatCompletion(wire.body,binding,profile);
 cases.push({name,candidates:count,source_messages:count,source_codepoints_each:length,serialized_bytes:receipt.serialized_bytes,
  approximate_input_tokens:receipt.input_tokens,configured_max_output_tokens:receipt.maxTokens,context_window_tokens:receipt.context_window_tokens,
  safety_margin_tokens:receipt.safety_margin_tokens,conservative_sum:receipt.input_tokens+receipt.maxTokens+receipt.safety_margin_tokens,
  original_input_guard_passes:true,actual_input_tokens:null,actual_output_tokens:null,request_fingerprint:prepared.fingerprint});
}
await identity.assertCurrent();
const result={version:1,source_stamp:identity.sourceStamp,real_model_calls:0,binding,profile,cases,
 interpretation:'input_tokens仍是原UTF-8字节代理；max_output_tokens为请求允许上限，不代表将产满或已消费。四个合成小窗通过原guard；真实材料和实际tokens由根会话另行记录。'};
await writeFile(new URL('./probe.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
