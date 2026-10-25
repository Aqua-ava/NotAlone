import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createEvidenceAliases} from '../src/reply-evidence-alias.ts';
import {buildReplyPayload} from '../src/reply-payload.ts';
import {parseReplyRequest} from '../src/reply-contract.ts';
import {replySystemPrompt} from '../src/reply-system-prompt.ts';
import {ReplyHistory} from '../src/reply-history.ts';
import {ReplySkillSession} from '../src/reply-skill-runtime.ts';
import {createReplyScenarioReadTool} from '../src/reply-preparation.ts';
import {createReplyOutputTool} from '../src/reply-loop.ts';

test('模型可见 system、payload、Tool schema 与 Skill 读取统一只含请求局部 alias',async()=>{
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),message=randomUUID(),candidate=randomUUID();
 const version=randomUUID(),preference=randomUUID(),scenario=randomUUID(),scenarioVersion=randomUUID();
 const profileVersion=randomUUID(),memory=randomUUID(),skillVersion=randomUUID();
 const businessJSON='{ "order_id": "INV-42", "number": 9007199254740993 }';
 const request=parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),skill_version_id:skillVersion,
  content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'新的表达',
   user_instruction:businessJSON,context_text:businessJSON,include_relationship_context:true}});
 const evidence={evidence_id:message,kind:'message',text:'合成消息',status:'active',selection_reason:'合成',
  timing:{source_started_at:null},event:null,conditions:null,evolution:{kind:'supplement',evidence_message_ids:[message]},
  valid_at:null,invalid_at:null,speaker_role:'contact',model_visible:true,source_ids:[memory]};
 const context={scope:{owner_id:owner,contact_id:contact},command:request,conversation_binding_id:binding,current_text:'新的表达',risk_notes:[],evidence:[evidence],
  layered_context:{payload_json:JSON.stringify({schema_version:3,profile_version_id:profileVersion,directory:[{scenario_id:scenario,version_id:scenarioVersion,title:'主题'}]})},
  owner_layered_context:{payload_json:JSON.stringify({schema_version:3,profile_version_id:profileVersion,profile_entries:[{memory_id:memory}]})}};
 const discussion={scope:{owner_id:owner,contact_id:contact},session_id:binding,request_key:request.idempotency_key,current_input_version_id:version,notice:'合成',snapshot:{},
  items:[{kind:'generation_input',text:JSON.stringify({request_id:request.idempotency_key,content:{user_instruction:businessJSON},continuation:{submission:JSON.stringify({message_id:message})}}),
   input_version_id:version,turn_id:version,reply_request_id:request.idempotency_key,candidate_id:candidate,version_id:version,parent_version_id:null,candidate_number:1,version_number:0,
   is_default_display:true,is_explicitly_selected:true,basis_changes:[{kind:'memory_changed',evidence_id:memory}]}]};
 const aliases=createEvidenceAliases();
 const system=replySystemPrompt(context,discussion,aliases);
 const payload=buildReplyPayload({request,context,discussion,aliases,
  preferences:[{preference_id:preference,revision:1,text:'简短',scope:{contact_id:contact,reply_mode:null}}]});
 const history=new ReplyHistory({transaction:async()=>[],scope:{owner_id:owner,contact_id:contact},binding_id:binding,initial_evidence_ids:[message],
  requireCurrent:async()=>{},aliases});
 const scenarioTool=createReplyScenarioReadTool(async()=>JSON.stringify({status:'failed',reason:'synthetic'}));
 const outputTool=createReplyOutputTool(async()=> 'synthetic');
 const content='合成 Skill 正文',contentHash=createHash('sha256').update(content).digest('hex');
 const skill=await ReplySkillSession.open({catalog:async()=>({revision:'1',entries:[{skillId:randomUUID(),versionId:skillVersion,name:'synthetic-skill',description:'合成策略',contentHash,resourcePaths:[]}]}),
  validate:async()=>{},loadVersion:async()=>({content,contentHash}),resource:async()=>({content:new Uint8Array()})},
  {ownerId:owner,contactId:contact,scene:''},{skill_version_id:skillVersion,skill_disabled:false},undefined,aliases);
 try{
  const surfaces=JSON.stringify({system,payload,catalog:skill.catalogText(),
   receipt:await skill.runtime.readFile('/notalone/reply-skills/synthetic-skill/SKILL.md'),
   schemas:[...history.tools(),scenarioTool,outputTool].map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}))});
  for(const id of [owner,contact,binding,message,candidate,version,preference,scenario,scenarioVersion,profileVersion,memory,skillVersion])assert.ok(!surfaces.includes(id),id);
  assert.match(surfaces,/"evidence_id":"c\d+"/);
  assert.match(surfaces,/"session_id":"s\d+"/);
  assert.equal(aliases.resolveSkill(payload.skill_selection.version_id),skillVersion);
  assert.equal(payload.user_instruction,businessJSON);
  assert.equal(payload.context_text,businessJSON);
  assert.equal(JSON.parse(payload.assistant_discussion.items[0].text).content.user_instruction,businessJSON);
  assert.equal(aliases.resolveReference(system.match(/"scenario_id":"(r\d+)"/)[1]),scenario);
  assert.equal(aliases.resolveReference(payload.expression_preferences[0].preference_id),preference);
 }finally{skill.close();}
});
