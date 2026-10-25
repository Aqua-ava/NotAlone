/** 单次回复内的模型可见证据别名；真实来源身份只留在业务侧映射。 */
export interface EvidenceAliases {
  aliasFor(evidenceId:string):string;
  resolve(alias:string):string|undefined;
  referenceFor(realId:string):string;
  sessionFor(realId:string):string;
  resolveSession(alias:string):string|undefined;
  entries():readonly {alias:string;evidence_id:string}[];
}

class RequestEvidenceAliases implements EvidenceAliases {
  private readonly realByAlias=new Map<string,string>();
  private readonly aliasByReal=new Map<string,string>();
  private readonly realByReferenceAlias=new Map<string,string>();
  private readonly referenceByReal=new Map<string,string>();
  private readonly realBySessionAlias=new Map<string,string>();
  private readonly sessionByReal=new Map<string,string>();

  constructor(evidenceIds:readonly string[]){
    for(const evidenceId of evidenceIds)this.aliasFor(evidenceId);
  }

  aliasFor(evidenceId:string):string {
    const existing=this.aliasByReal.get(evidenceId);
    if(existing)return existing;
    const alias=`c${this.aliasByReal.size+1}`;
    this.aliasByReal.set(evidenceId,alias);
    this.realByAlias.set(alias,evidenceId);
    return alias;
  }

  resolve(alias:string){return this.realByAlias.get(alias);}

  referenceFor(realId:string):string {
   const evidence=this.aliasByReal.get(realId);
   if(evidence)return evidence;
   const existing=this.referenceByReal.get(realId);
   if(existing)return existing;
   const alias=`r${this.referenceByReal.size+1}`;
   this.referenceByReal.set(realId,alias);
   this.realByReferenceAlias.set(alias,realId);
   return alias;
  }

  sessionFor(realId:string):string {
   const existing=this.sessionByReal.get(realId);
   if(existing)return existing;
   const alias=`s${this.sessionByReal.size+1}`;
   this.sessionByReal.set(realId,alias);
   this.realBySessionAlias.set(alias,realId);
   return alias;
  }

  resolveSession(alias:string){return this.realBySessionAlias.get(alias);}

  entries(){return [...this.aliasByReal].map(([evidence_id,alias])=>({alias,evidence_id}));}
}

export function createEvidenceAliases(evidenceIds:readonly string[]=[]):EvidenceAliases {
  return new RequestEvidenceAliases(evidenceIds);
}

export function restoreReplyEvidenceAliases(value:unknown,aliases:EvidenceAliases):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const output=value as Record<string,unknown>;
  if(!Array.isArray(output.candidates))return value;
  return {...output,candidates:output.candidates.map(candidate=>{
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return candidate;
    const row=candidate as Record<string,unknown>;
    if(!Array.isArray(row.citation_ids))return candidate;
    return {...row,citation_ids:row.citation_ids.map(citation=>
      typeof citation==='string'?aliases.resolve(citation)??null:null)};
  })};
}

const referenceIdFields=new Set(['candidate_id','version_id','parent_version_id','message_id','request_key','input_version_id','current_input_version_id','turn_id','current_turn_id','reply_request_id','memory_id','candidate_version_id','skill_version_id']);
const referenceIdArrayFields=new Set(['candidate_ids','version_ids','message_ids','turn_ids','reply_request_ids']);
export function aliasReplyDiscussionText(text:string,aliases:EvidenceAliases):string {
  try {
   const parsed=JSON.parse(text);
   if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Array.isArray((parsed as Record<string,unknown>).messages))
    return JSON.stringify(aliasReplyEvidenceReferences(parsed,aliases));
  }catch{}
  return text;
}
export function aliasReplyEvidenceReferences(value:unknown,aliases:EvidenceAliases):unknown {
  if(Array.isArray(value))return value.map(item=>aliasReplyEvidenceReferences(item,aliases));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[
    key,
    key==='evidence_id'&&typeof item==='string'
      ?aliases.aliasFor(item)
      :key==='allowed_evidence_ids'&&Array.isArray(item)
        ?item.map(id=>typeof id==='string'?aliases.aliasFor(id):id)
        :key==='evidence_message_ids'&&Array.isArray(item)
          ?item.map(id=>typeof id==='string'?aliases.aliasFor(id):id)
          :key==='session_id'&&typeof item==='string'
            ?aliases.sessionFor(item)
            :referenceIdFields.has(key)&&typeof item==='string'
              ?aliases.referenceFor(item)
              :referenceIdArrayFields.has(key)&&Array.isArray(item)
                ?item.map(id=>typeof id==='string'?aliases.referenceFor(id):id)
          :aliasReplyEvidenceReferences(item,aliases),
  ]));
}
