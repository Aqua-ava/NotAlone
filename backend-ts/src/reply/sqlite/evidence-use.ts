/** 纯证据合同：模型如何使用材料与工具如何呈现材料集中维护，不依赖框架或存储。 */
const GROUNDED_DETAIL_RULE='用户要求核对细节且资料已证明该细节时，至少一条候选必须说出该项已知内容；只在basis引用、只重复本次任务的话题或泛泛问候不算完成核对。再按本次表达意图自然组织措辞；需要确认现状时再询问，不擅自填补其余字段。';
const CONTEXT_LINK_RULE='提交前逐条核对跨片段关系：把两段事实串成同一事项的变化、矛盾或因果，必须有资料直接支持同一对象、活动和条件；同一个人或老师、相同词语及日期先后都不够。不同语境可分别陈述或带限定比较；关联未证且本次确需时补查，否则省略关联，不为凑不同说法拼接其他片段。';
export const RELATIONSHIP_EVIDENCE_GUIDE=`<relationship-evidence-guide>
命中后的证据使用：
先核对材料实际支持的命题，再组织候选；检索排名、材料编号和已入模标记都不是事实正确或适用的证明。引用应直接支持候选所述事实，不能用仅话题相关的材料凑依据。
把已找到的事实与仍缺失的信息分开：已知阶段、范围或过去安排时应利用该信息，仅缺确切日期、时刻或现状就只保留那一项未知，不能概括成整个安排或相关记录都未找到。“不要猜测”不等于省略已有证据支持的细节。${GROUNDED_DETAIL_RULE}不要求所有候选复述相同信息。
历史说法只证明当时说过、计划过或适用过，不自动证明现在仍成立；可基于历史事实自然询问现状。保留原话中的不确定性、条件和程度，不把“好像、可能”升级为肯定，也不凭来源日期推算未提供的具体日期或时刻。
比较、归纳或连接多条资料前，核对主体、所指对象、活动或场所、时间和适用条件。不同或尚不明确时分别理解，不能仅因都出现同一词就串成“以前如此、后来变化”、矛盾或同一制度。邻近原话帮助确认指代，时间接近本身不证明同一话题；同一时间或未知时间不补造先后顺序。${CONTEXT_LINK_RULE}
候选是用户发给联系人的话。助手的检索状态和查证过程留在助手侧，不把“我查了、我没查到、不瞎猜”等过程冒充用户经历，也不把助手不知道变成用户不知道；缺少事实时可以写自然的确认问题。只有本次用户明确要表达其真实查找经历时，才按该经历组织措辞。
</relationship-evidence-guide>`;

export interface RelationshipSearchResultView {
 status:string;items:{itemNo:number;kind:string;text:string;identity?:object}[];
 code?:string;kind?:'memory'|'history';indexIncomplete?:boolean;
}

/** 同组按已知时间呈现；读取优先级不是对话顺序，未知或同时间不补造先后。 */
function chronologicalEvidence(items:RelationshipSearchResultView['items']):RelationshipSearchResultView['items']{
 const groups=new Map<number,RelationshipSearchResultView['items']>();
 const groupOf=(item:RelationshipSearchResultView['items'][number])=>{
  const identity=item.identity as Record<string,unknown>|undefined;
  return item.kind==='message'&&Number.isSafeInteger(identity?.evidenceGroup)&&Number(identity?.evidenceGroup)>0?Number(identity!.evidenceGroup):null;
 };
 for(const item of items){const group=groupOf(item);if(group!==null){const rows=groups.get(group)??[];rows.push(item);groups.set(group,rows);}}
 const time=(item:RelationshipSearchResultView['items'][number]):bigint|null=>{
  const value=(item.identity as Record<string,unknown>|undefined)?.sentAt;
  return typeof value==='bigint'?value:typeof value==='number'&&Number.isSafeInteger(value)?BigInt(value):typeof value==='string'&&/^-?\d+$/.test(value)?BigInt(value):null;
 };
 const rendered=new Set<number>(),result:RelationshipSearchResultView['items']=[];
 for(const item of items){
  const group=groupOf(item);if(group===null){result.push(item);continue;}if(rendered.has(group))continue;rendered.add(group);
  const rows=groups.get(group)!;
  result.push(...(rows.every(row=>time(row)!==null)?[...rows].sort((a,b)=>time(a)!<time(b)!?-1:time(a)!>time(b)!?1:0):rows));
 }
 return result;
}

/** 成功只报告实际返回材料，不替模型把命中解释为问题已全部回答。 */
export function renderRelationshipSearchResult(result:RelationshipSearchResultView):string{
 if(result.status==='ok'&&result.items.length){
  const heading=`已返回${result.items.length}条实际材料；请区分已找到的事实与仍缺失的信息。引用前核对所指对象、时间和条件，命中不表示问题已全部回答。${GROUNDED_DETAIL_RULE}${CONTEXT_LINK_RULE}`;
  const incomplete=result.indexIncomplete?'本机检索索引仍在补齐；以下仅为当前可用检索路径返回的实际材料，不能据此断言已找到所有相关资料。\n\n':'';
  return incomplete+heading+'\n\n'+chronologicalEvidence(result.items).map(item=>{
   const identity=item.identity as Record<string,unknown>|undefined;
   const group=Number.isSafeInteger(identity?.evidenceGroup)&&Number(identity?.evidenceGroup)>0?`本次工具返回的片段组${identity!.evidenceGroup}；`:'';
   const role=identity?.evidenceRole==='context'?`（${group}邻近语境，非独立检索命中；有界取样不保证完整会话，时间接近不代表同一话题${identity.contextPosition==='same_time'?'；先后顺序未核验':''}）`:identity?.evidenceRole==='match'&&group?`（${group}检索命中）`:'';
   return `实际输入材料[${item.itemNo}] ${item.kind}${role}\n${item.text}`;
  }).join('\n\n');
 }
 if(result.code==='reply_search_index_incomplete')return '本机检索索引尚未补齐，本次未取得可引用结果；这不是完整检索后的未命中，不能据此认定资料不存在。请使用已有材料，缺失信息保持未知。';
 if(result.code==='reply_search_timeout'&&result.kind==='memory')return '本次记忆检索已超时，未完成本次获准记忆搜索；不能据此认定资料不存在，请使用已有信息或在剩余次数内重试。';
 if(result.code==='reply_search_timeout')return '本次历史检索已超时，未完成当前联系人的全部获准历史搜索；不能据此认定资料不存在，请使用已有信息或在剩余次数内重试。';
 if(result.status==='empty'||result.status==='ok')return '本次查询未命中；这不代表相关资料不存在，请保持未知，不据此补写事实。';
 if(result.code==='reply_search_budget_exceeded'||['exhausted','budget_exceeded'].includes(result.status))return '本轮检索预算已耗尽，未读取更多正文。请使用已有材料，缺失信息保持未知。';
 if(['rejected','denied'].includes(result.status))return '本次查询被拒绝，未读取正文。请使用已有材料，不扩大本轮范围。';
 return '本次检索能力暂不可用，未取得可用正文。请使用已有材料，缺失信息保持未知。';
}
