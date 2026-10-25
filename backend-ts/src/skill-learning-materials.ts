/** 从授权范围生成有界学习批次；模型只见材料与现有策略身份，不直接读库。 */
import type {Client} from 'pg';
import {activeRef} from './contact-overview-evidence.ts';
import type {SkillFiles,SkillVersionFiles} from './skill-files.ts';
import {wholeStrategyId} from './skill-execution-view.ts';
import {
  MAX_LEARNING_INPUT_CHARS,MAX_LEARNING_MATERIALS,SkillLearningInvalid,
  codepointLength,finishBatch,learningInputText,skillContentDigest,type LearningMaterial,type LearningTarget,
  type SkillLearningBatch,type SkillLearningScope,
} from './skill-learning-contract.ts';
import {captureParentPublications,isSkillPersistenceError,type Visit} from './skill-source-proof.ts';
import {
  expandSkillProvenance,requireSkillDependencies,
} from './skill-source-dependencies.ts';
import {captureSkillGeneration} from './skill-source-proof.ts';
import {SkillPortError} from './skill-execution-view.ts';

type Row=Record<string,any>;
type EventRow={
  material_id:string;priority:'correction'|'ordinary';session_id:string;kind:string;content:any;
  dependencies:Set<string>;created_at:string;candidates?:unknown[];external_messages?:unknown[];
};
const PAGE=32;
function textTimestamp(value:unknown):string {
  const text=String(value??'');
  return `${text.endsWith('.000000')?text.slice(0,-7):text}+00:00`;
}
function ordered(event:EventRow){return event.priority!=='correction'?1:0;}
async function* mergeEvents(generators:AsyncGenerator<EventRow>[]):AsyncGenerator<EventRow>{
  const iterators=generators.map(generator=>generator[Symbol.asyncIterator]()),current=await Promise.all(iterators.map(iterator=>iterator.next()));
  while(true){
    const available=current.map((item,index)=>({item,index})).filter(({item})=>!item.done);
    if(!available.length)break;
    available.sort((left,right)=>ordered((left.item.value! as EventRow))-ordered(right.item.value! as EventRow)
      ||String((left.item.value as EventRow).created_at).localeCompare(String((right.item.value as EventRow).created_at))
      ||String((left.item.value as EventRow).material_id).localeCompare(String((right.item.value as EventRow).material_id)));
    const chosen=available[0];
    yield chosen.item.value as EventRow;
    current[chosen.index]=await iterators[chosen.index].next();
  }
}
async function* pages(query:(offset:number)=>Promise<Row[]>):AsyncGenerator<Row>{
  for(let offset=0;;offset+=PAGE){
    const rows=await query(offset);yield* rows;if(rows.length<PAGE)return;
  }
}
async function expandMessageSources(client:Client,owner:string,dependencies:Set<string>):Promise<Set<string>>{
  const rows=(await client.query(`SELECT coalesce(ref.source_document_id,ref.observation_id) AS source_id
    FROM public.message_source_ref ref WHERE ref.owner_id=$1 AND ref.message_id=ANY($2::uuid[])
    AND (EXISTS(SELECT 1 FROM public.source_document source WHERE source.id=ref.source_document_id
      AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id AND source.status='active')
      OR EXISTS(SELECT 1 FROM public.local_wechat_observation observation WHERE observation.id=ref.observation_id
        AND observation.owner_id=ref.owner_id AND observation.contact_id=ref.contact_id))`,
  [owner,[...dependencies]])).rows;
  return new Set([...dependencies,...rows.map(row=>row.source_id as string)]);
}
async function* inputEvents(client:Client,scope:SkillLearningScope,ids:string[]|null):AsyncGenerator<EventRow>{
  for await(const row of pages(offset=>client.query(`
    SELECT input.id,input.session_id,input.content,turn.input_payload,
      coalesce(turn.dependency_ids,input.dependency_ids) AS dependencies,turn.reply_request_id,
      to_char(input.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS created_at,input.turn_id
    FROM public.assistant_session_input input
    LEFT JOIN public.assistant_session_turn turn ON turn.id=input.turn_id
    JOIN public.conversation_binding binding ON binding.id=input.conversation_binding_id
    WHERE input.owner_id=$1 AND input.contact_id=$2 AND input.state='active'
      AND binding.owner_id=input.owner_id AND binding.contact_id=input.contact_id AND binding.status='active'
      AND (input.turn_id IS NULL OR turn.state='completed')
      AND ($3::uuid[] IS NULL OR input.id=ANY($3::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM public.skill_learning_receipt receipt
        WHERE receipt.owner_id=input.owner_id AND receipt.contact_id=input.contact_id AND receipt.material_id=input.id)
    ORDER BY (coalesce(coalesce(input.content,turn.input_payload)->>'correction','')<>'') DESC,input.created_at,input.id
    LIMIT ${PAGE} OFFSET $4`,[scope.owner_id,scope.contact_id,ids,offset]).then(result=>result.rows))){
    const content=row.content??row.input_payload;if(!content)continue;
    const dependencies=new Set<string>(row.dependencies??[]);dependencies.add(row.session_id);dependencies.add(row.id);
    if(row.turn_id)dependencies.add(row.turn_id);
    let candidates:unknown[]=[];
    if(row.reply_request_id){
      candidates=(await client.query('SELECT id,message_group FROM public.reply_candidate WHERE owner_id=$1 AND contact_id=$2 AND reply_request_id=$3 ORDER BY id',
        [scope.owner_id,scope.contact_id,row.reply_request_id])).rows.map(item=>({candidate_id:item.id,message_group:item.message_group}));
      dependencies.add(row.reply_request_id);
      for(const item of candidates as Row[])dependencies.add(item.candidate_id);
    }
    yield {material_id:row.id,session_id:row.session_id,
      kind:row.content?'assistant_discussion':'assistant_usage',
      priority:content.correction?'correction':'ordinary',content,candidates,dependencies,
      created_at:textTimestamp(row.created_at)};
  }
}
async function* editEvents(client:Client,scope:SkillLearningScope,ids:string[]|null):AsyncGenerator<EventRow>{
  for await(const row of pages(offset=>client.query(`
    SELECT version.id,version.session_id,version.turn_id,version.candidate_id,version.message_group,
      version.requirements,to_char(version.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS created_at,
      turn.dependency_ids
    FROM public.assistant_candidate_version version
    JOIN public.assistant_session_turn turn ON turn.id=version.turn_id
    JOIN public.conversation_binding binding ON binding.id=turn.conversation_binding_id
    WHERE version.owner_id=$1 AND version.contact_id=$2 AND version.version_number>0
      AND turn.state='completed' AND binding.status='active'
      AND ($3::uuid[] IS NULL OR version.id=ANY($3::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM public.skill_learning_receipt receipt
        WHERE receipt.owner_id=version.owner_id AND receipt.contact_id=version.contact_id AND receipt.material_id=version.id)
    ORDER BY version.created_at,version.id LIMIT ${PAGE} OFFSET $4`,
  [scope.owner_id,scope.contact_id,ids,offset]).then(result=>result.rows))){
    yield {material_id:row.id,session_id:row.session_id,kind:'candidate_edit',priority:'correction',
      content:{message_group:row.message_group,requirements:row.requirements},
      dependencies:new Set([...(row.dependency_ids??[]),row.id,row.session_id,row.turn_id,row.candidate_id]),
      created_at:textTimestamp(row.created_at)};
  }
}
async function* selectionEvents(client:Client,scope:SkillLearningScope,ids:string[]|null):AsyncGenerator<EventRow>{
  for await(const row of pages(offset=>client.query(`
    SELECT selection.id,selection.session_id,selection.candidate_id,selection.version_id,
      coalesce(version.message_group,candidate.message_group) AS message_group,
      to_char(selection.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS created_at,
      turn.dependency_ids,turn.id AS turn_id
    FROM public.assistant_candidate_selection selection
    JOIN public.assistant_candidate_version version ON version.id=selection.version_id
    JOIN public.reply_candidate candidate ON candidate.id=selection.candidate_id
    JOIN public.assistant_session_turn turn ON turn.id=version.turn_id
    JOIN public.conversation_binding binding ON binding.id=turn.conversation_binding_id
    WHERE selection.owner_id=$1 AND selection.contact_id=$2 AND turn.state='completed' AND binding.status='active'
      AND ($3::uuid[] IS NULL OR selection.id=ANY($3::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM public.skill_learning_receipt receipt
        WHERE receipt.owner_id=selection.owner_id AND receipt.contact_id=selection.contact_id AND receipt.material_id=selection.id)
    ORDER BY selection.created_at,selection.id LIMIT ${PAGE} OFFSET $4`,
  [scope.owner_id,scope.contact_id,ids,offset]).then(result=>result.rows))){
    yield {material_id:row.id,session_id:row.session_id,kind:'candidate_selection',priority:'ordinary',
      content:{message_group:row.message_group,sending_status:'unknown'},
      dependencies:new Set([...(row.dependency_ids??[]),row.id,row.session_id,row.candidate_id,row.version_id,row.turn_id]),
      created_at:textTimestamp(row.created_at)};
  }
}
async function* followupEvents(client:Client,scope:SkillLearningScope,ids:string[]|null):AsyncGenerator<EventRow>{
  for await(const row of pages(offset=>client.query(`
    SELECT message.id,message.text_content,message.speaker,
      to_char(message.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS occurred_at,
      turn.id AS turn_id,turn.session_id,turn.dependency_ids,turn.input_payload
    FROM public.message message
    JOIN LATERAL (
      SELECT turn.id,turn.session_id,turn.dependency_ids,turn.input_payload
      FROM public.assistant_session_turn turn
      JOIN public.conversation_binding binding ON binding.id=turn.conversation_binding_id
        AND binding.owner_id=turn.owner_id AND binding.contact_id=turn.contact_id
      WHERE turn.owner_id=message.owner_id AND turn.contact_id=message.contact_id
        AND turn.state='completed' AND binding.status='active'
        AND message.occurred_at>=turn.created_at AND message.occurred_at<=turn.created_at+interval '24 hours'
        AND EXISTS(SELECT 1 FROM public.message anchor WHERE anchor.owner_id=turn.owner_id
          AND anchor.contact_id=turn.contact_id AND anchor.id=ANY(turn.dependency_ids) AND anchor.id<>message.id
          AND anchor.occurred_at<=turn.created_at)
        AND EXISTS(SELECT 1 FROM public.message_source_ref ref
          JOIN public.local_wechat_observation observation ON observation.id=ref.observation_id
            AND observation.owner_id=ref.owner_id AND observation.contact_id=ref.contact_id
          WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id
            AND ref.contact_id=message.contact_id AND observation.binding_id=binding.id
            AND observation.is_reliable)
      ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1
    ) turn ON true
    WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.message_type='text'
      AND message.speaker IN ('user','contact')
      AND ($3::uuid[] IS NULL OR message.id=ANY($3::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM public.skill_learning_receipt receipt
        WHERE receipt.owner_id=message.owner_id AND receipt.contact_id=message.contact_id AND receipt.material_id=message.id)
    ORDER BY message.occurred_at,message.id LIMIT ${PAGE} OFFSET $4`,
  [scope.owner_id,scope.contact_id,ids,offset]).then(result=>result.rows))){
    yield {material_id:row.id,session_id:row.session_id,kind:'followup_observation',priority:'ordinary',
      content:{text:row.text_content,speaker:row.speaker,task_input:row.input_payload,sending_status:'unknown',
        effectiveness:'unknown',notice:'同绑定任务后24小时内的有限观察，不证明因果或实际采用。'},
      dependencies:new Set([...(row.dependency_ids??[]),row.id,row.turn_id,row.session_id]),
      created_at:textTimestamp(row.occurred_at)};
  }
}
async function publishedMethods(client:Client,scope:SkillLearningScope,skill:string,version:string):Promise<{method_id:string;logical_skill_id:string}[]|null>{
  const row=(await client.query(`SELECT strategy->'methods' AS methods FROM public.skill_draft
    WHERE owner_id=$1 AND logical_skill_id=$2 AND published_version_id=$3 AND status='published'
    ORDER BY created_at DESC,id DESC LIMIT 1`,[scope.owner_id,skill,version])).rows[0];
  if(!row)return [{method_id:wholeStrategyId(skill),logical_skill_id:skill}];
  if(!Array.isArray(row.methods)||row.methods.length<1||row.methods.length>6)return null;
  const result:{method_id:string;logical_skill_id:string}[]=[],seen=new Set<string>();
  for(const item of row.methods){
    if(!item||typeof item.method_id!=='string'||typeof item.logical_skill_id!=='string'
      ||item.logical_skill_id!==skill||seen.has(item.method_id)
      ||!/^[0-9a-f-]{36}$/i.test(item.method_id))return null;
    seen.add(item.method_id);result.push({method_id:item.method_id,logical_skill_id:item.logical_skill_id});
  }
  return result;
}
export async function selectLearningBatch(
  client:Client,
  scope:SkillLearningScope,
  files:SkillFiles,
  visit:Visit,
  materialIds:string[]|null=null,
):Promise<SkillLearningBatch>{
  const materials:LearningMaterial[]=[],allDependencies=new Set<string>();
  let materialBudgetLimited=false;
  for await(const event of mergeEvents([
    inputEvents(client,scope,materialIds),editEvents(client,scope,materialIds),
    selectionEvents(client,scope,materialIds),followupEvents(client,scope,materialIds),
  ])){
    const currentEvent=event as EventRow;
    if(materialIds&&!materialIds.includes(currentEvent.material_id))continue;
    let refs:Set<string>;
    try{refs=await expandSkillProvenance(client,scope.owner_id,scope.contact_id,[...currentEvent.dependencies],visit);}
    catch(error){
      if(isSkillPersistenceError(error))throw error;
      if(visit.requireDiscussionDependencies)throw new SkillLearningInvalid();else continue;
    }
    let parents:Row[],inherited:Set<string>;
    try{({proofs:parents,inherited}=await captureParentPublications(client,scope.owner_id,scope.contact_id,[...refs],visit));}
    catch(error){if(error instanceof SkillPortError)continue;throw error;}
    const ordinary=await expandMessageSources(client,scope.owner_id,
      new Set([...refs].filter(id=>!inherited.has(id))));
    const raw=(await client.query(`SELECT id FROM public.source_document WHERE id=ANY($3::uuid[]) AND (owner_id<>$1 OR contact_id<>$2)
      UNION ALL SELECT id FROM public.message WHERE id=ANY($3::uuid[]) AND (owner_id<>$1 OR contact_id<>$2)
      UNION ALL SELECT id FROM public.local_wechat_observation WHERE id=ANY($3::uuid[]) AND (owner_id<>$1 OR contact_id<>$2)`,
    [scope.owner_id,scope.contact_id,[...ordinary]])).rows;
    if(raw.length)continue;
    const originalRefs=new Set([...ordinary,...inherited]);
    try{await requireSkillDependencies(client,scope.owner_id,scope.contact_id,[...originalRefs],visit);}
    catch(error){if(isSkillPersistenceError(error))throw error;continue;}
    const messages=(await client.query(`SELECT message.id,message.speaker,message.text_content,
      to_char(message.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS occurred_at
      FROM public.message message WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
        AND EXISTS(SELECT 1 FROM public.message_source_ref ref
          WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id
            AND ref.contact_id=message.contact_id AND ${activeRef})
        ORDER BY message.occurred_at NULLS LAST,message.id LIMIT 6`,
    [scope.owner_id,scope.contact_id,[...ordinary]])).rows;
    const material:LearningMaterial={...currentEvent,
      external_messages:messages.map(item=>({message_id:item.id,speaker:item.speaker,text:item.text_content,
        occurred_at:item.occurred_at?textTimestamp(item.occurred_at):null})),
      dependency_ids:[...new Set([...ordinary,...parents.flatMap(item=>[item.skill_id,item.version_id])])].sort(),digest:''};
    delete (material as Row).dependencies;
    material.digest=skillContentDigest(material);
    const receipt=(await client.query(`SELECT 1 FROM public.skill_learning_receipt
      WHERE owner_id=$1 AND contact_id=$2 AND material_id=$3 AND digest=$4`,
    [scope.owner_id,scope.contact_id,material.material_id,material.digest])).rowCount;
    if(receipt)continue;
    if(codepointLength(learningInputText([material],[]))>MAX_LEARNING_INPUT_CHARS)continue;
    if(materials.length>=MAX_LEARNING_MATERIALS)break;
    if(codepointLength(learningInputText([...materials,material],[]))>MAX_LEARNING_INPUT_CHARS){materialBudgetLimited=true;break;}
    materials.push(material);for(const id of originalRefs)allDependencies.add(id);
  }
  const targets:LearningTarget[]=[];
  const library=(await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[scope.owner_id])).rows[0];
  const rows=(await client.query(`SELECT skill.id AS skill_id,skill.name,version.id,version.id AS version_id,version.version_number,
    version.content_path,version.document_sha256,version.content_sha256,version.manifest_sha256,
    version.method_manifest_path,version.method_manifest_sha256,skill.owner_id
    FROM public.reply_skill skill JOIN public.reply_skill_version version ON version.skill_id=skill.id
    WHERE skill.owner_id=$1 AND skill.status='active' AND version.enabled AND version.is_current
      AND version.status='active' AND version.content_path IS NOT NULL AND version.directory_available
      AND (skill.contact_id IS NULL OR skill.contact_id=$2)
    ORDER BY skill.name,skill.id LIMIT 8`,[scope.owner_id,scope.contact_id])).rows;
  for(const row of rows){
    try{
      const {proofs,inherited}=await captureParentPublications(client,scope.owner_id,scope.contact_id,[row.version_id],visit);
      if(proofs.length!==1)continue;
      const methods=await publishedMethods(client,scope,row.skill_id,row.version_id);if(methods===null)continue;
      const fileRow=row as SkillVersionFiles&Row,manifest=files.readManifest(fileRow);
      if(manifest.name!==row.name)continue;
      const document=files.readContent(fileRow);
      const target:LearningTarget={skill_id:row.skill_id,version_id:row.version_id,version_number:row.version_number,
        name:row.name,description:manifest.description,document,methods,
        scope:proofs[0].scope,source_dependency_count:inherited.size};
      if(codepointLength(learningInputText(materials,[...targets,target]))>MAX_LEARNING_INPUT_CHARS)continue;
      const inheritedRefs=await expandSkillProvenance(client,scope.owner_id,scope.contact_id,[row.skill_id,row.version_id],visit);
      await requireSkillDependencies(client,scope.owner_id,scope.contact_id,[...inheritedRefs],visit);
      targets.push(target);for(const id of inheritedRefs)allDependencies.add(id);
    }catch(error){if(isSkillPersistenceError(error))throw error;continue;}
  }
  const setting=(await client.query('SELECT revision FROM public.skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',
    [scope.owner_id,scope.contact_id])).rows[0];
  const dependencyIds=[...allDependencies].sort();
  return finishBatch({materials,targets,dependency_ids:dependencyIds,
    library_revision:Number(library?.revision??0),scope_revision:Number(setting?.revision??0),
    source_generation:await captureSkillGeneration(client,scope.owner_id,scope.contact_id,dependencyIds),
    material_budget_limited:materialBudgetLimited});
}
