/** 单次回复内的模型可见证据别名；真实来源身份只留在业务侧映射。 */
export interface EvidenceAliases {
  aliasFor(evidenceId:string):string;
  resolve(alias:string):string|undefined;
  entries():readonly {alias:string;evidence_id:string}[];
}

class RequestEvidenceAliases implements EvidenceAliases {
  private readonly realByAlias=new Map<string,string>();
  private readonly aliasByReal=new Map<string,string>();

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
          :aliasReplyEvidenceReferences(item,aliases),
  ]));
}
