/** 显式历史 bounded-v1 的 grounded-v2 标注、确定性编译和正文约束。 */
import {calendar,sourceCalendar} from './calendar.ts';
import {
  instantMicros,requireValid,uuid,validateExtractionWindow,when,
  type ExtractedFact,type ExtractionMessage,type ExtractionWindow,
} from './protocol.ts';
import {
  representations,validateBody,type Message,type Representation,
} from '../overview/evidence/bounded-body.ts';

export const boundedPromptProfile='bounded-dependency-teaching-v2' as const;
export const groundedCompilerVersion='grounded-source-event-v1' as const;
const KINDS={
  event:['common_fact','assertion','asserted'],
  relationship_event:['relationship_note','assertion','asserted'],
  reported_event:['relationship_note','report','reported'],
  third_party_fact:['relationship_note','report','reported'],
  assessment:['relationship_note','assertion','asserted'],
  preference:['preference','assertion','asserted'],
  taboo:['taboo','assertion','asserted'],
  state:['recent_state','assertion','asserted'],
  momentary_state:['recent_state','assertion','asserted'],
  plan:['recent_state','plan','asserted'],
  hypothesis:['recent_state','plan','hypothetical'],
  request:['relationship_note','request','asserted'],
  correction:['relationship_note','correction','asserted'],
  unknown:['relationship_note','unknown','unknown'],
} as const;
const OMISSIONS=new Set(['question','greeting','nonliteral','not_memory']);
const TOPICS=new Set(['health','work','family','travel','finance','study','emotion','other']);
const SUBJECTS=new Set(['self','contact','shared']);
const SENSITIVITY=new Set(['none','financial','health','commitment','other']);
const ROW_FIELDS=['kind','subject','topic','dependency','unresolved','confidence','sensitivity'];
const OBSERVED_KINDS=new Set(['state','momentary_state','request']);
const PERIOD_KINDS=new Set(['plan','hypothesis']);
const CONDITION=/^(?:如果|假如|要是|倘若|若)/u;
const KNOWN_INTERPRETATION='按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。';
const COMPLETED_INTERPRETATION='原文完成问答明确表示动作已完成，程序据此保留历史动作，不设置当天失效。';
/** bounded 路径的未决指代标注：整组非此即拒收，采纳门槛据此区分真歧义与自由文本不确定性。 */
export const AMBIGUITY_NOTE='原文指代在本窗口无法唯一确定，保留原句。';

const GROUNDED_V2_PROMPT=`对同一联系人的原文分句进行结构化标注。只返回工具结构，不改写正文。
units是按工具预设字段填写的对象，每个target字段必填，不再输出unit编号；context 仅供理解，不单独输出。不能删除分句来掩盖不知道或未决定。
先判断是否有独立可保存信息，纳入判定优先于后续阶段：仅推进本次消息交换的动作，没有独立事实、明确承诺、关系约束或其他安排时用not_memory，不能仅凭将来时态或意向就纳入。真实计划、责任约定及承诺仍保留，是否有承诺不以出现保证词为条件；纯礼貌用greeting。通过纳入判定后，再按本句独立主断言选择kind及阶段：
event=对话一方的普通可复用事实，包含已完成动作及未限定短期期间的稳定身份、职业、专业；relationship_event=主断言为本人已参与的互动关系经历（含收到邀请、借用、赠予）；主断言是普通动作的完成进度或结果时用event，人物关系或对象来历仅作背景不能把它改成relationship_event；
reported_event=第三方历史经历；third_party_fact=第三方身份资料；assessment=针对具体事项的一次评价；
preference=有来源的长期习惯或偏好；taboo=长期禁忌；state=当前知情、决策或持续期未知的状态；
momentary_state=正在等待、路上等当天瞬时状态；plan=尚未实现的计划；hypothesis=假设；
已通过纳入判定时，明确尚未发生的既定日程、工作安排或约定也用plan，不要求自主打算或“准备／想”等意向词；时间已定或语气确定不等于当前持续的state。
先核候选保存的主张阶段，不能仅见未来时间词就标plan：当前知情、未决定或不知道仍用state；正在进行、已完成和长期身份分别沿原类型，不能因句中涉及未来事项就把主张阶段改为plan。
assessment也可表达对未来行为的当前明确判断或预测；未来时间词和简短肯定／否定本身不证明行动安排，按完整相连问答确定言语行为，省略回答保留理解必需的问句dependency。
已通过纳入判定时，明示未来日程、意图、安排或承诺仍用plan并保留原敏感性，当前不知道或未决定仍用state；来源仅表达可能性、假设、条件或转引时保留原限定并沿相应原类型，不能借assessment抹掉限定或改成确定结果。
已通过纳入判定时，尚未开始而即将执行的即时意向仍用plan，不因接近说话时刻就当作正在进行或已经完成；来源明确正在进行才用momentary_state，明确完成才按已完成动作处理。
request=暂时关系要求；correction=窗内有明确先前主张的更正；unknown=无法判断。
不能独立成立的时间/话题前缀（例如“前年冬天，”或“他现在的情况，”）用prefix，和紧邻的同消息事实合并。
纯条件前件用condition，紧邻其后的同消息动作必须用plan或hypothesis，程序会合并并保留条件。
question/greeting/nonliteral/not_memory是明确不提取的原因；说话者不知道他人情况是state，不是not_memory。
来源明确描述反复的日常行为且未限定资料期间时用preference；“现在”等陈述时点不把习惯变成state或momentary_state，无期限习惯沿双null，不从单次行为推长期习惯。
反问式强调按完整相连语境判断主张，不能当作字面否定或仅凭问号省略；真实询问和没有明示主张的质疑仍不提取。若有两种来源支持的读法，保留unresolved，不反转明确否定。
已完成动作与当前状态分别标注。已收到邀约是relationship_event，不额外产生一条未来参与计划。
subject为资料归属self/contact/shared，不能把第三人身份改成用户或联系人；其资料依原说话人范围保存。
候选保存对话一方直接提出的请求时，subject归请求者，不归受话者、被要求的执行者或受益者；联系人提出要求归contact，用户提出要求归self。
sender只是说话人，不必等于subject：转述第三方请求仍保留第三方称呼、原关系资料范围和转述边界；描述另一方事实仍归该方，共同约定才按共同主张判断。
topic按主断言选择受控主题：主断言为明确亲属间互动优先family；亲属称呼仅为背景而主断言是职业、学习等资料时按work、study等实际主题，不因称呼强改family。职业/职业知情用work，课程报名用study，价格判断可用finance。地点是家里或有人来访本身不能证明亲属关系。
dependency只选一条理解本句不可缺少的原文分句编号；可以是context或另一target。
相连问答已足够时不再引用更早的历史；不需要补全人物/事项时用null。若一条依赖不足以消歧，unresolved=true。
逐项检查主断言及其必要限定中的人物、事项、对象及角色指称；任一所需指称无法唯一确定即unresolved=true，只有全部所需指称均明确才false。请求者和受话者明确不证明请求事项明确；保留已知部分和原类型。不能从亲属性别推测说话者性别。
sensitivity只标原文实际的敏感风险：financial=真实金钱风险，health=健康，commitment=明确承诺，other=其他明确敏感性。
普通借用物品、报价判断、收到娱乐邀请本身不是敏感性，取none。不要增加原文没有的风险。
confidence是模型对标签的把握，不能代替证据。程序只保证定位、引用、字段组合与时间计算，不认证你的语义判断。

仅本E2的event沿既有普通事实映射；模型仍须依据完整原文选择，程序不把state自动改为event。
“目前／现在”仅表示陈述时点时，不把稳定资料改成临时state；不从此类资料推真实开始日、永久有效、能力或成果。
明确短期期间、当前知情／决策、身体近况和未来安排继续用原状态或计划类型；第三方身份仍用third_party_fact。
保留原文的否定、猜测、引语和未知，不把它们改成肯定身份；稳定资料标签也不认证现实真伪或来源可信。
unresolved不仅检查人物，也检查理解主张所需的事项、对象及角色；已有来源不能唯一确定时标true，保留原类型和已知部分，不用请求的受话者已知掩盖事项未知。
family须有原文亲属或家庭关系依据，不能仅因家里／住处或来访就选family；按实际主张选择已有依据的topic，没有更具体依据时用other。
先判断是否有值得保存的信息，再选事实或计划类型：仅推进当前对话的一次性消息传递动作（发送地址、文件等），且没有独立事实、明确承诺、关系约束或超出本次消息交换的安排时用not_memory；有信息的地址／文件内容及真实计划、承诺仍分别保留，不按物品词或短期性一概省略。
不含独立事实的纯礼貌谢语用greeting，不因存在依赖或前句已完成就另标event；同句或相邻句确有关系经历、完成动作或其他事实时，分别保留有信息的分句，不删除整条消息。

<e2_teaching_examples>
以下是独立教学微例，均由联系人说出，只展示局部标签，不是当前工具输出，也不是本次来源。
示例中的context仅为背景，只有target需要输出；当前任务只标注随后user消息里的实际target，完整字段按当前工具schema填写。
第一对：第三人事实与本人参与。
例一 target「隔壁摊主的职业是篆刻师。」：kind=third_party_fact，topic=work，unresolved=false。职业属于第三人，不能改成联系人的职业。
例二 target「隔壁摊主当面向我发出了联展邀请。」：kind=relationship_event，topic=other，unresolved=false。保存已收到邀请，不另造未来参与计划。
第二对：亲属关系主断言与关系背景下的普通完成。
例三 target「姨父送给了我一套雕刻工具。」：kind=relationship_event，topic=family，unresolved=false。
例四 context「这套雕刻工具是姨父送我的。」；唯一target「最后一块木版已经刻完了。」：kind=event，topic=other，unresolved=false。只保存完成主断言；不补具体雕刻者，不推断使用了所赠工具，背景不单独输出，也不作为不必要的dependency。
第三对：当前消息维护与真实未来计划／安排。
例五 target「稍等，我把这条消息的错字改一下。」：两分句均为not_memory，topic=other，unresolved=false；仅维护本次消息，没有独立可保存安排。
例六 target「下个月的古文字课上，我会替你演示拓印步骤。」：首分句kind=prefix、后句kind=plan，均topic=study、unresolved=false；前缀合并至未来计划。不补已完成或具体事件发生日期，其他字段沿原来源及时间规则。
第四对：事项未明与事项明确但尚未决定。
例七 target「我对先前说的安排仍拿不定主意。」（无其他context）：kind=state，topic=other，unresolved=true。保留犹豫状态，所指事项未明。
例八 target「我还没决定下学期是否转去夜校。」：kind=state，topic=study，unresolved=false。事项明确，未知的是决定结果，不能把当前未决定改为未来计划。
</e2_teaching_examples>
`;
const BOUNDED_STAGE=`\n<bounded_stage_teaching_v1>
以下独立教学对照只说明既有kind的阶段边界，不是本次来源或工具输出。
完成动作与持续活动：
「我已经把书架擦干净了。」保存已完成的清洁动作，kind=event；
「我正在擦书架。」保存仍在进行的活动，kind=momentary_state。
完成结果与身体状态：
「我已经量完体温了。」保存已完成的测量动作，kind=event；
「我现在有点头晕。」保存当前身体近况，kind=state。
动作发生得近不等于它仍在持续；当前状态也不能因可能短暂而编造已完成动作。
回到实际target及其必要上下文独立判断；其余槽位仍按原定义填写，不复制教学句或补出未明说的事实。
</bounded_stage_teaching_v1>\n`;
const BOUNDED_DEPENDENCY=`\n<bounded_dependency_teaching_v2>
以下独立对照只说明既有dependency槽，不是当前来源，不指定其它标签。
必要的明确别名映射：context 0:0「我把实验记录册叫作青签。」；target 1:0「青签已经编号好了。」。
虽然target字面是一句完整陈述，理解其中对象仍使用0:0的别名映射，因此该target的dependency为0:0。
无关背景：context 0:0「今天窗外有雾。」；target 1:0「实验记录册已经编号好了。」。
target的人物和事项无需该背景补全，因此该target的dependency为null。
必要的显式声明不因在另一条消息、另一个target或前文中就变成无关背景；一句话字面完整也不等于所需指称已独立明确。
只选择实际窗口中理解当前主张不可缺少的原文分句；不把所有背景加入依赖，不复制微例编号或正文。
微例不定义新的证明语法，也不认证别名、人物或任何关系；当前任务仍按原全部字段及未知规则输出。
</bounded_dependency_teaching_v2>\n`;

export function boundedExtractionPrompt():string{return GROUNDED_V2_PROMPT+BOUNDED_STAGE+BOUNDED_DEPENDENCY;}

export interface SourceUnit {
  id:string;message:ExtractionMessage;start:number;end:number;target:boolean;text:string;
}
export class BoundedExtractionError extends Error {
  readonly failure_kind='invalid_output';
  constructor(message='原文结构提取不符合契约。'){super(message);this.name='BoundedExtractionError';}
}
const invalid=(message='原文结构提取不符合契约。'):never=>{throw new BoundedExtractionError(message);};
export const codeLength=(text:string):number=>Array.from(text).length;
export const codeSlice=(text:string,start:number,end?:number):string=>Array.from(text).slice(start,end).join('');
const targetIdSet=(window:ExtractionWindow):Set<string>=>new Set((window.target_message_ids??window.messages.map(message=>message.message_id)).map(uuid));
function sourceOffset(text:string,index:number):number{return codeLength(text.slice(0,index));}
/** 只按原文可见标点切分，位置均为 Unicode 码点半开区间。 */
export function sourceUnits(window:ExtractionWindow):SourceUnit[]{
  validateExtractionWindow(window);const targets=targetIdSet(window),units:SourceUnit[]=[];
  window.messages.forEach((message,messageIndex)=>{
    let ordinal=0;
    for(const match of message.text.matchAll(/[^，；;。！？!?\n]+[，；;。！？!?\n]*/gu)){
      if(!match[0].trim())continue;
      const start=sourceOffset(message.text,match.index!),end=start+codeLength(match[0]);
      units.push({id:`${messageIndex}:${ordinal++}`,message,start,end,target:targets.has(uuid(message.message_id)),text:codeSlice(message.text,start,end)});
    }
  });
  if(units.length>512)invalid('原文分句超出单窗口结构预算。');
  return units;
}
function enumSchema(values:string[]){return {type:'string',enum:[...values].sort()};}
function needsReference(unit:SourceUnit):boolean{return /^(?:现在|目前)?[他她它]/u.test(unit.text);}
function referenceChoices(unit:SourceUnit,units:SourceUnit[]):string[]{
  const result:string[]=[];for(const other of units){if(other.id===unit.id)break;if(!needsReference(other))result.push(other.id);}return result;
}
export function boundedExtractionSchema(window:ExtractionWindow):Record<string,any>{
  const units=sourceUnits(window),properties:Record<string,any>={};
  for(const unit of units){
    if(!unit.target)continue;
    const property:Record<string,any>={
      type:'object',additionalProperties:false,
      properties:{
        kind:enumSchema([...Object.keys(KINDS),...OMISSIONS,'condition','prefix']),
        subject:enumSchema([...SUBJECTS]),topic:enumSchema([...TOPICS]),
        dependency:{enum:[null,...units.filter(other=>other.id!==unit.id).map(other=>other.id)]},
        unresolved:{type:'boolean'},confidence:{type:'number',minimum:0,maximum:1},
        sensitivity:enumSchema([...SENSITIVITY]),
      },
      required:ROW_FIELDS.slice(),
    };
    if(needsReference(unit)){
      const branches:Record<string,any>[]=[
        {properties:{unresolved:{const:true}}},
        {properties:{kind:enumSchema([...OMISSIONS])}},
      ];
      const anchors=referenceChoices(unit,units);if(anchors.length)branches.push({properties:{dependency:{enum:anchors}}});
      property.anyOf=branches;
      property.description='此原句含第三人指代：保存事实且unresolved=false时，dependency必须选择先前的独立依据。找不到可靠依据就unresolved=true；不能用后面的回答或另一个裸指代自证。';
    }
    properties[unit.id]=property;
  }
  return {title:'GroundedMemoryLabels',description:'填写程序指定的每个原文位置，不生成编号，不改写正文。',
    type:'object',additionalProperties:false,
    properties:{units:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}},
    required:['units']};
}
export function boundedExtractionInput(window:ExtractionWindow):string{
  return sourceUnits(window).map(unit=>`[${unit.id}] [${unit.target?'target':'context'}] sender=${unit.message.sender} occurred_at=${unit.message.occurred_at??'unknown'} 原文=${unit.text}`).join('\n');
}
function sourceDate(message:ExtractionMessage):string|null{
  const value=message.occurred_at;if(value===null)return null;
  const match=value.match(/^(\d{4}-\d{2}-\d{2})/);return match?.[1]??null;
}
function sourceLocalISO(message:ExtractionMessage):string|null{
  const anchor=sourceCalendar(message);if(!anchor)return null;
  const rows=message.source_snapshots??[],values=rows.map(row=>(row.raw_payload as Record<string,unknown>|undefined)?.time_iso);
  if(!values.length||values.some(value=>typeof value!=='string'))return null;
  return values[0] as string;
}
/** bounded运行只把规范消息时刻换成同一活动来源的原偏移；无证明时保持null。 */
export function normalizeBoundedWindow(window:ExtractionWindow):ExtractionWindow{
  return {...window,messages:window.messages.map(message=>({...message,occurred_at:sourceLocalISO(message)}))};
}
function isoAt(milliseconds:number,offsetMinutes:number):string{
  const local=new Date(milliseconds+offsetMinutes*60000).toISOString().replace('.000Z','');
  const sign=offsetMinutes<0?'-':'+';
  return `${local}${sign}${String(Math.floor(Math.abs(offsetMinutes)/60)).padStart(2,'0')}:${String(Math.abs(offsetMinutes)%60).padStart(2,'0')}`;
}
function period(expression:string,message:ExtractionMessage):[string|null,string|null]{
  if(/不|没|非|除|别|勿|取消|改期/u.test(expression))return [null,null];
  const tokens=[...expression.matchAll(/(?:[上下前后本这每大小]+个?)?(?:周末|周[一二三四五六日天]?|今天|明天|后天)(?:之前|之后|以前|以后|前|后|起|左右|期间|内)?/gu)].map(match=>match[0]);
  const supported=new Set(['下周末','本周末','这周末','周末','下周','本周','这周','今天','明天','后天']);
  if(tokens.length!==1||!supported.has(tokens[0]!))return [null,null];
  const token=tokens[0]!,value=calendar(token,sourceCalendar(message));
  return value?[value.start,value.end]:[null,null];
}

type Label=Record<string,any>;
type ParsedUnit={unit:SourceUnit;label:Label};
function unitId(raw:unknown):string{
  requireValid(typeof raw==='string');
  const match=/^\[?([0-9]+:[0-9]+)\]?$/u.exec(raw);requireValid(Boolean(match));return match![1]!;
}
function labels(window:ExtractionWindow,draft:unknown):Map<string,Label>{
  const root=draft as Record<string,any>|null;
  requireValid(root&&typeof root==='object'&&!Array.isArray(root)&&Object.keys(root).sort().join(',')==='units');
  const units=root!.units;requireValid(units&&typeof units==='object'&&!Array.isArray(units));
  const source=sourceUnits(window),targets=new Set(source.filter(unit=>unit.target).map(unit=>unit.id));
  requireValid(Object.keys(units).sort().join('|')===[...targets].sort().join('|'));
  const result=new Map<string,Label>();
  for(const [rawId,value] of Object.entries(units as Record<string,unknown>)){
    const id=unitId(rawId);requireValid(targets.has(id)&&!result.has(id));
    const label=value as Label;
    requireValid(label&&typeof label==='object'&&!Array.isArray(label)&&Object.keys(label).sort().join(',')===ROW_FIELDS.slice().sort().join(','));
    requireValid((Object.hasOwn(KINDS,label.kind)||OMISSIONS.has(label.kind)||['condition','prefix'].includes(label.kind))
      &&SUBJECTS.has(label.subject)&&TOPICS.has(label.topic)&&SENSITIVITY.has(label.sensitivity)
      &&typeof label.unresolved==='boolean'&&typeof label.confidence==='number'&&Number.isFinite(label.confidence)
      &&label.confidence>=0&&label.confidence<=1);
    if(label.dependency!==null){label.dependency=unitId(label.dependency);}
    result.set(id,{...label});
  }
  const allIds=new Set(source.map(unit=>unit.id));
  for(const unit of source){
    if(!unit.target)continue;
    const label=result.get(unit.id)!;
    if(label.dependency!==null)requireValid(allIds.has(label.dependency));
    if(needsReference(unit)&&!OMISSIONS.has(label.kind)&&!label.unresolved){
      requireValid(referenceChoices(unit,source).includes(label.dependency));
      requireValid(!result.get(label.dependency)?.unresolved);
    }
  }
  return result;
}
function dependencies(members:SourceUnit[],rows:Map<string,Label>,byId:Map<string,SourceUnit>):SourceUnit[]{
  const internal=new Set(members.map(unit=>unit.id)),result=new Map<string,SourceUnit>();
  const visit=(key:string|null,path:Set<string>):void=>{
    if(key===null||internal.has(key))return;
    const unit=byId.get(key);requireValid(Boolean(unit)&&!path.has(key)&&path.size<8);
    const next=new Set(path);next.add(key);result.set(key,unit!);
    const label=rows.get(key);if(label&&label.dependency!==null&&!next.has(label.dependency))visit(label.dependency,next);
  };
  for(const member of members)visit(rows.get(member.id)?.dependency??null,new Set());
  return [...result.values()];
}
function completedAnswer(unit:SourceUnit,deps:SourceUnit[]):boolean{
  if(unit.start!==0||deps.length!==1)return false;
  const answer=/^(?:我)?(?:已经|已)?(?<verb>抵达|到达|到|签收|办完|取到|送达|交完|完成)了[，。！!]*$/u.exec(unit.text);
  const question=deps[0]!;
  if(!answer||question.message.sender===unit.message.sender||question.start!==0)return false;
  if(Number(question.id.split(':')[0])>=Number(unit.id.split(':')[0]))return false;
  const verb=answer.groups!.verb!;
  const match=new RegExp(`^你(?:已经|已)?${verb}(?<object>[^，。！？!?]{0,32})了吗[？?]$`,'u').exec(question.text);
  if(!match)return false;
  const object=match.groups!.object!;
  if(['到','到达','抵达'].includes(verb)&&!/^[\u4e00-\u9fffA-Za-z0-9]{0,20}(?:机场|车站|码头|公司|学校|医院|酒店|宾馆|场馆|办公室|目的地|家)$/u.test(object))return false;
  return !/不|没|别|勿|如果|假如|明天|后天|将|打算|计划|时间|时候|期限|截止|到期|年龄|岁|点|日|周|月|年/u.test(object);
}

const E2_SUBJECT='(?:我们|我|你)?';
const E2_UNCERTAIN='(?:可能|也许|不一定)';
const E2_STATE=new RegExp(`^${E2_SUBJECT}${E2_UNCERTAIN}(?:有点|有些|稍微)?(?:感冒|发烧|咳嗽|头疼|头晕|不舒服)[，。]?$`,'u');
const E2_BARE_CLOCK=/^(?:今天)?(?:我)?(?:加班|工作|值班|学习|等候)到(?:十一|十二|一|二|两|三|四|五|六|七|八|九|十)点[，。]?$/u;
const E2_AMOUNT='[1-9][0-9]{0,5}(?:\\.[0-9]{1,2})?(?:w|万|元)';
const E2_MODALS=['','计划','打算','准备','要','会','约好','一起','都','临时','只','就','才','可能','也许','不一定'];
const E2_SUBJECTS=['','我','你','我们'];
const E2_WEATHER=/^(?<time>今天|明天|后天|本周|这周|下周|本周末|这周末|周末|下周末|下个月|下月)(?:下雨|降雨|不下雨|不降雨|天晴)$/u;
const E2_NUMBER='(?:[0-9一二两三四五六七八九十百]+(?:多|来|几)?|半|几|数|若干)';
const E2_PHASE='(?:之前|之后|以前|以后|以内|左右|期间|中旬|[上中下]旬|初|底|末|前|后|起|内)';
const E2_WEEK_DAY='(?:本|这|下)?周[一二三四五六日天]';
const E2_DAY_WORD='(?:[上下前后本这每大小]+个?)?(?:周末|周[一二三四五六日天]?|今天|明天|后天)';
const E2_TIME_WORD=new RegExp(`(?:(?:${E2_DAY_WORD})(?:(?:到|至)${E2_WEEK_DAY})?(?:(?:上午|下午|晚上|中午|凌晨|午夜|早上|傍晚)?${E2_NUMBER}点(?:半|${E2_NUMBER}分)?|[0-9]{1,2}:[0-9]{2})?(?:${E2_PHASE})?)|(?:(?:[上下前后本这每大小再隔另]+|${E2_NUMBER})个?月(?:份)?(?:${E2_PHASE})?|月${E2_PHASE})|(?:${E2_NUMBER}个?(?:年|周末|星期|礼拜|周|天|日|号|小时|时|点|分钟|分|秒))|(?:[前去今明后本这每]+年|星期|礼拜|以后|将来|之前|之后|上旬|中旬|下旬|月初|月中|月底|月末|期间|以内|左右)`,'gu');
const E2_RESERVED=['我们','我','你','不','没','非','除','别','勿','如果','假如','要是','倘若','然后','但是','不过','另外','其实','并且','还要','已经','刚刚','刚','曾经','取消','改期','去','回','来','到','在','玩','旅行','出差','发展','参加','工作','值班','入职','出发','休息','露营','爬山','吃饭','请','带','吃','之前','之后','起','左右','期间','以内','可能','也许','一定','会','准备'];
type E2Action={time:string|null;modal:string;family:string};
type E2Condition={outer_time:string|null;condition_time:string|null;action:E2Action;scenario_time:string|null};
const body=(text:string):string=>/[，。]$/u.test(text)?text.slice(0,-1):text;
const opaque=(text:string):boolean=>/^[\u4e00-\u9fff]{1,32}$/u.test(text)&&!E2_RESERVED.some(word=>text.includes(word))&&!new RegExp(E2_TIME_WORD.source,'u').test(text);
function e2Event(value:string):string|null{
  if(['入职','出发','休息','露营','爬山','吃饭','去露营','去爬山','去吃饭'].includes(value))return 'activity';
  if(['请你吃饭','请你喝茶','请你爬山','请你露营'].includes(value))return 'response';
  if(value.startsWith('带你去吃')&&opaque(value.slice(4)))return 'response';
  if(value.startsWith('参加')&&opaque(value.slice(2)))return 'activity';
  const choices:string[]=[];
  if(/^[去回来到]/u.test(value)){const rest=value.slice(1);for(const suffix of ['','玩','旅行','出差','发展']){
    const place=suffix?(rest.endsWith(suffix)?rest.slice(0,-suffix.length):''):rest;
    if(opaque(place))choices.push('move');
  }if(rest.includes('参加')){const [place,,object]=rest.split(/参加/u);if(opaque(place??'')&&opaque(object??''))choices.push('move');}}
  if(value.startsWith('在'))for(const suffix of ['','工作','值班']){const place=suffix?(value.endsWith(suffix)?value.slice(1,-suffix.length):''):value.slice(1);if(opaque(place))choices.push('location');}
  return choices.length===1?choices[0]!:null;
}
function e2Action(text:string,conditional=false):E2Action|null{
  const value=body(text),times=[...value.matchAll(new RegExp(E2_TIME_WORD.source,'gu'))],choices=new Map<string,E2Action>();
  const modals=[...E2_MODALS,...(conditional?['一定']:[])];
  for(const subject of E2_SUBJECTS)for(const before of times.length?modals:(conditional?['','一定','就','才','只']:[''])){
    const prefix=subject+before;if(!value.startsWith(prefix))continue;
    let time:string|null,rest:string;
    if(times.length){if(times.length!==1||times[0]!.index!==codeLength(prefix))continue;time=times[0]![0];rest=value.slice(times[0]!.index!+times[0]![0].length);}
    else{time=null;rest=value.slice(prefix.length);}
    for(const after of time!==null&&!before?modals:['']){
      if(!rest.startsWith(after))continue;let event=rest.slice(after.length);
      if(event.startsWith('不会'))event=event.slice(2);else if(event.startsWith('不'))event=event.slice(1);
      const family=e2Event(event);if(family)choices.set(JSON.stringify([time,before||after,family]),{time,modal:before||after,family});
    }
  }
  return choices.size===1?[...choices.values()][0]!:null;
}
function precondition(text:string):[boolean,string|null]{
  for(const weather of ['下雨','降雨','不下雨','不降雨','天晴'])if(text.endsWith(weather)){const time=text.slice(0,-weather.length);if(!time||new RegExp(`^${E2_TIME_WORD.source}$`,'u').test(time))return [true,time||null];}
  const match=new RegExp(E2_TIME_WORD.source,'u').exec(text),time=match?.[0]??null,rest=match?text.slice(match[0].length):text;
  if((time===null||time.endsWith('前'))&&(rest==='能完工'||['能完成','能做完'].some(prefix=>rest.startsWith(prefix)&&opaque(rest.slice(prefix.length)))))return [true,time];
  if(time===null&&/^[你我][来到到]/u.test(rest))return [opaque(rest.slice(2)),null];
  return [false,null];
}
function e2Condition(first:string,second:string):E2Condition|null{
  if(!first.endsWith('，')||first.endsWith('，，'))return null;
  const action=e2Action(second,true);if(!action)return null;
  const value=first.slice(0,-1),match=new RegExp(E2_TIME_WORD.source,'u').exec(value),outer=match?.[0]??null,rest=match?value.slice(match[0].length):value;
  for(const connector of ['如果','假如','要是','倘若','若'])if(rest.startsWith(connector)){
    const [valid,inner]=precondition(rest.slice(connector.length));if(!valid)continue;
    const scenario=E2_WEATHER.exec(rest.slice(connector.length)),bodyAction=body(second);
    const completeResponse=!['吧','了','吗'].some(marker=>bodyAction.includes(marker))
      &&E2_SUBJECTS.some(subject=>bodyAction.startsWith(subject+'就')&&e2Event(bodyAction.slice(subject.length+1))!==null);
    return {outer_time:outer,condition_time:inner,action,scenario_time:outer===null&&scenario&&completeResponse?scenario.groups!.time!:null};
  }
  if(outer===null&&value.endsWith('的话')){const [valid,inner]=precondition(value.slice(0,-2));if(valid)return {outer_time:null,condition_time:inner,action,scenario_time:null};}
  if(value.startsWith('你要是')&&/[来到到]/u.test(value[3]??'')&&opaque(value.slice(4)))return {outer_time:null,condition_time:null,action,scenario_time:null};
  return null;
}
function eligible(window:ExtractionWindow,members:SourceUnit[],deps:SourceUnit[],candidateChars:number):boolean{
  const ids=window.messages.map(message=>message.message_id);
  return window.target_message_ids!==null&&window.messages.length>0&&window.messages.length<=4
    &&new Set(ids).size===ids.length&&window.messages.every(message=>codeLength(message.text)<=4096)
    &&members.length>0&&members.length<=2&&deps.length<=4&&candidateChars<=4096
    &&members.every(member=>member.message.message_id===members[0]!.message.message_id&&member.target)
    &&[...members,...deps].every(unit=>ids.includes(unit.message.message_id));
}
function uncertainState(text:string):boolean{return E2_STATE.test(text);}
function uncertainPlan(text:string):boolean{
  const action=e2Action(text);if(action&&['可能','也许','不一定'].includes(action.modal))return true;
  const match=new RegExp(`^${E2_SUBJECT}(?:以后|将来)?${E2_UNCERTAIN}(?:不)?(?<event>.+?)[，。]?$`,'u').exec(text);
  return Boolean(match&&e2Event(match.groups!.event!));
}
function financialAtom(text:string):boolean{
  if(new RegExp(`^(?:我)?贷款 ?${E2_AMOUNT} ?(?:加仓|投资|周转)$`,'u').test(text))return true;
  const match=new RegExp(E2_TIME_WORD.source,'u').exec(text);let value=text;
  if(match){if(!new RegExp(`^(?:${E2_DAY_WORD})(?:(?:上午|下午|晚上|中午|凌晨|午夜|早上|傍晚)?(?:十一|十二|一|二|三|四|五|六|七|八|九|十)点)?$|^(?:本|这|下)周|^(?:本|这|下)?周末$|^下个?月$`,'u').test(match[0]))return false;value=text.slice(match[0].length);if(value.startsWith(' '))value=value.slice(1);}
  return new RegExp(`^${E2_AMOUNT} ?到手$`,'u').test(value);
}
function financialChallenge(window:ExtractionWindow,unit:SourceUnit,deps:SourceUnit[]):boolean{
  if(window.messages.length!==2||deps.length!==1)return false;
  const [claim,challenge]=window.messages,dep=deps[0]!;
  if(unit.message.message_id!==claim.message_id||claim.sender===challenge.sender||dep.message.message_id!==challenge.message_id||dep.start!==0||dep.end!==codeLength(challenge.text)||!/^你(?:又)?(?:开始)?(?:吹|吹牛)(?:了)?。?$/u.test(challenge.text))return false;
  const atoms=body(claim.text).split('，');return atoms.length>=1&&atoms.length<=2&&atoms.every(financialAtom)&&financialAtom(body(unit.text));
}
function offsetMinutes(raw:string):number{
  if(raw.endsWith('Z'))return 0;const match=/([+-])(\d\d):(\d\d)$/u.exec(raw);requireValid(Boolean(match));
  return (match![1]==='-'?-1:1)*(Number(match![2])*60+Number(match![3]));
}
function localParts(anchor:string){const offset=offsetMinutes(anchor),ms=Date.parse(anchor)+offset*60000,date=new Date(ms);
  return {date,offset,year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate()};}
function localDayStart(anchor:string,dayOffset=0):string{
  const {date,offset}=localParts(anchor);const local=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+dayOffset);
  return isoAt(local,offset);
}
function weekday(token:string,dayStart:string,inherited:string|null=null):string|null{
  const match=/^(?<week>本|这|下)?周(?<day>[一二三四五六日天])$/u.exec(token);if(!match)return null;
  const week=match.groups!.week??inherited,value=match.groups!.day==='天'?'日':match.groups!.day!;
  const index='一二三四五六日'.indexOf(value),parts=localParts(dayStart),weekday=(parts.date.getUTCDay()+6)%7;
  const offset=-weekday+index+(week==='下'?7:0);const result=localDayStart(dayStart,offset);
  if(week===null&&Date.parse(result)<Date.parse(dayStart))return null;return result;
}
function weekStart(anchor:string,weekOffset:0|1,weekend:boolean):string{
  const parts=localParts(anchor),weekday=(parts.date.getUTCDay()+6)%7;
  return localDayStart(anchor,-weekday+7*weekOffset+(weekend?5:0));
}
function e2Calendar(token:string,anchor:string|null):[string,string]|null{
  if(anchor===null)return null;
  let start:string|null=null,lengthDays=1;
  if(['今天','明天','后天'].includes(token))start=localDayStart(anchor,{'今天':0,'明天':1,'后天':2}[token as '今天'|'明天'|'后天']);
  else if(['下个月','下月'].includes(token)){
    const parts=localParts(anchor),date=new Date(Date.UTC(parts.year,parts.month,1));
    start=isoAt(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1),parts.offset);
    const end=isoAt(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1),parts.offset);return [start,end];
  }else if(['本周','这周','下周'].includes(token)){start=weekStart(anchor,token==='下周'?1:0,false);lengthDays=7;}
  else if(['本周末','这周末','周末','下周末'].includes(token)){start=weekStart(anchor,token==='下周末'?1:0,true);lengthDays=2;}
  else{
    const range=new RegExp(`^(?<first>${E2_WEEK_DAY})(?:到|至)(?<last>${E2_WEEK_DAY})$`,'u').exec(token);
    if(range){const first=weekday(range.groups!.first,localDayStart(anchor)),last=weekday(range.groups!.last,localDayStart(anchor),range.groups!.first!.startsWith('周')?null:range.groups!.first![0]!);
      if(!first||!last||Date.parse(first)>Date.parse(last)||new Date(first).getUTCDay()!==new Date(last).getUTCDay())return null;return [first,localDayStart(last,1)];}
    const clock=new RegExp(`^(?<day>今天|明天|后天|${E2_WEEK_DAY})(?<part>上午|下午|晚上|中午)(?<hour>十一|十二|一|二|三|四|五|六|七|八|九|十)点$`,'u').exec(token);
    if(clock){const day=token.slice(0,-(clock.groups!.part!.length+clock.groups!.hour!.length+1)),hours={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12},hour=hours[clock.groups!.hour as keyof typeof hours],part=clock.groups!.part!;
      if(!(part==='上午'&&hour>=1&&hour<=11||part==='下午'&&hour>=1&&hour<=6||part==='晚上'&&hour>=6&&hour<=11||part==='中午'&&hour===12))return null;
      const dayStart=localDayStart(anchor,{'今天':0,'明天':1,'后天':2}[day as '今天'|'明天'|'后天']??0);if(!['今天','明天','后天'].includes(day)&&weekday(day,localDayStart(anchor))===null)return null;
      const ms=Date.parse(dayStart)+(hour+(part==='下午'||part==='晚上'?12:0))*3600000,parts=localParts(anchor);start=isoAt(ms,parts.offset);return [start,localDayStart(start,1)];}
    return null;
  }
  if(!start)return null;return [start,localDayStart(start,lengthDays)];
}
function e2Dates(unit:SourceUnit,deps:SourceUnit[],kind:string,valid:string|null,invalid:string|null,frame:E2Condition|null):[string|null,string|null]{
  const previous:[string|null,string|null]=[valid,invalid];
  if(!['plan','hypothesis','state'].includes(kind)||deps.some(dep=>new RegExp(E2_TIME_WORD.source,'u').test(dep.text)))return previous;
  let actionText=unit.text;
  if(frame===null&&['吧','了','吗'].some(marker=>actionText.includes(marker))){
    const particle=/^(?<action>[^吧了吗]+)吧。?$/u.exec(actionText);
    if(!['plan','hypothesis'].includes(kind)||unit.end!==codeLength(unit.message.text)||!particle)return previous;actionText=particle.groups!.action!;
  }
  const action=frame?.action??e2Action(actionText);if(!action)return previous;
  const anchor=sourceLocalISO(unit.message);let time=action.time,unreliable=false;
  if(frame){
    if(frame.outer_time!==null&&time!==null){const outer=e2Calendar(frame.outer_time,anchor),inner=e2Calendar(time,anchor);
      const contained=outer&&inner&&Date.parse(outer[0])<=Date.parse(inner[0])&&Date.parse(inner[1])<=Date.parse(outer[1]);
      if(JSON.stringify(outer)!==JSON.stringify(inner)&&!contained)return ['plan','hypothesis'].includes(kind)?[null,null]:previous;}
    time=time??frame.outer_time??frame.scenario_time;unreliable=time===null&&frame.condition_time!==null;
  }
  if(time===null)return unreliable&&['plan','hypothesis'].includes(kind)?[null,null]:previous;
  const interval=e2Calendar(time,anchor);
  if(interval){
    if(['plan','hypothesis'].includes(kind))return interval;
    if(new RegExp(`^${E2_WEEK_DAY}(?:到|至)${E2_WEEK_DAY}$`,'u').test(time))return interval;
    if(action.family==='location'&&action.modal==='临时'&&['本周','这周'].includes(time)&&anchor&&Date.parse(interval[0])<=Date.parse(anchor)&&Date.parse(anchor)<Date.parse(interval[1]))return [anchor,interval[1]];
    return previous;
  }
  unreliable=new RegExp(`^(?:${E2_DAY_WORD})(?:(?:上午|下午|晚上|中午|凌晨|午夜|早上|傍晚)?${E2_NUMBER}点(?:半|${E2_NUMBER}分)?|[0-9]{1,2}:[0-9]{2})?(?:${E2_PHASE})?$`,'u').test(time);
  return unreliable&&['plan','hypothesis'].includes(kind)?[null,null]:previous;
}

export function compileGroundedLabels(window:ExtractionWindow,draft:unknown):ExtractedFact[]{
  const units=sourceUnits(window),byId=new Map(units.map(unit=>[unit.id,unit])),rows=labels(window,draft);
  const targets=units.filter(unit=>unit.target),results:ExtractedFact[]=[],contexts=new Map<string,SourceUnit[]>(),unknownGroups=new Map<string,ExtractedFact>();
  const conditionPairs=new Map<string,E2Condition>(),memberGroups=new Map<string,SourceUnit[]>();
  for(let index=0;index+1<units.length;index++){
    const first=units[index]!,second=units[index+1]!,firstLabel=rows.get(first.id),secondLabel=rows.get(second.id);
    if(!first.target||!second.target||first.message.message_id!==second.message.message_id||first.end!==second.start||!firstLabel||!secondLabel||!['condition','prefix'].includes(firstLabel.kind))continue;
    if(secondLabel.kind==='plan'&&eligible(window,[first,second],[],0)){const frame=e2Condition(first.text,second.text);if(frame)conditionPairs.set(first.id,frame);}
    if(Object.hasOwn(KINDS,secondLabel.kind))memberGroups.set(first.id,[first,second]),memberGroups.set(second.id,[first,second]);
  }
  let pending:SourceUnit|null=null;
  for(const unit of targets){
    const row=rows.get(unit.id)!;
    let kind=String(row.kind);
    if(['condition','prefix'].includes(kind)){
      requireValid(pending===null&&!(kind==='condition'&&!CONDITION.test(unit.text)&&!conditionPairs.has(unit.id)));pending=unit;continue;
    }
    const condition=pending;pending=null;
    if(OMISSIONS.has(kind)){requireValid(condition===null);continue;}
    if(condition){requireValid(condition.message.message_id===unit.message.message_id&&(rows.get(condition.id)!.kind!=='condition'||['plan','hypothesis'].includes(kind))&&!OMISSIONS.has(kind));}
    const members=[...(condition?[condition]:[]),unit];
    const deps=dependencies(members,rows,byId);
    const sources=[unit.message.message_id];for(const dep of deps)if(!sources.includes(dep.message.message_id))sources.push(dep.message.message_id);
    const quote=members.map(member=>member.text).join(''),author=unit.message.sender==='self'?'用户':'联系人';
    const completed=condition===null&&['state','momentary_state'].includes(kind)&&completedAnswer(unit,deps);if(completed)kind='event';
    const mapping=KINDS[kind as keyof typeof KINDS];requireValid(Boolean(mapping));
    const category=String(mapping![0]);let speech=String(mapping![1]),assertion=String(mapping![2]),figurative='literal';
    const flags:string[]=row.sensitivity==='none'?[]:[`sensitivity:${row.sensitivity}`];
    if(condition&&rows.get(condition.id)!.sensitivity!=='none')flags.push(`sensitivity:${rows.get(condition.id)!.sensitivity}`);
    let valid:string|null=null,invalid:string|null=null;const anchor=sourceLocalISO(unit.message);
    if(OBSERVED_KINDS.has(kind)){
      valid=anchor;if(kind==='momentary_state'&&anchor!==null)invalid=localDayStart(anchor,1);
    }
    if(PERIOD_KINDS.has(kind)){
      [valid,invalid]=period(quote,unit.message);
      if(valid===null)flags.push('grounded:unresolved_period');
      if(condition?.id&&rows.get(condition.id)?.kind==='condition'||CONDITION.test(quote))assertion='conditional';
    }
    const observed=anchor!==null&&OBSERVED_KINDS.has(kind)?`截至${sourceDate(unit.message)}，`:'';
    const contextText=contextsFor(deps,memberGroups,rows);
    const text=`${observed}${author}原话：“${quote}”${contextText}`;
    if(eligible(window,members,deps,codeLength(text))){
      if(members.length===1){
        if(['state','momentary_state'].includes(kind)&&assertion==='asserted'){
          if(uncertainState(unit.text))assertion='unknown';
          if(E2_BARE_CLOCK.test(unit.text)){speech='unknown';assertion='unknown';valid=null;invalid=null;}
        }
        if(kind==='plan'&&assertion==='asserted'&&uncertainPlan(unit.text))assertion='unknown';
        if(kind!=='third_party_fact'&&financialChallenge(window,unit,deps))figurative='unknown';
      }
      if(condition&&conditionPairs.has(condition.id)&&assertion==='asserted')assertion='conditional';
      const frame=condition?conditionPairs.get(condition.id)??null:null;
      if(speech!=='unknown'&&(members.length===1||frame))[valid,invalid]=e2Dates(unit,deps,kind,valid,invalid,frame);
    }
    if(PERIOD_KINDS.has(kind)&&valid===null)flags.push('grounded:unresolved_period');
    let unresolved=members.some(member=>rows.get(member.id)!.unresolved);
    if(/^(?:现在|目前)?[他她它](?!们)/u.test(quote)&&deps.length===0)unresolved=true;
    const alternatives=unresolved?[AMBIGUITY_NOTE]:[];
    if(deps.some(dep=>rows.get(dep.id)?.unresolved))alternatives.push('所依赖原文仍有未决指代，当前候选不能据此消歧。');
    if(kind==='unknown')flags.push('grounded:unresolved_kind');
    const fact:ExtractedFact={
      text,category,subject:String(row.subject),topic:String(row.topic),source_message_ids:[...sources],
      confidence:Math.min(...members.map(member=>Number(rows.get(member.id)!.confidence))),risk_flags:[...new Set(flags)],
      valid_at:valid,invalid_at:invalid,speech_act:speech as ExtractedFact['speech_act'],assertion_status:assertion as ExtractedFact['assertion_status'],figurative_type:figurative as ExtractedFact['figurative_type'],
      alternatives,interpretation_reason:completed?COMPLETED_INTERPRETATION:KNOWN_INTERPRETATION,requires_all_sources:true,
      source_dependency_mode:'any',_scene_name:'原文分句',event:null,conditions:null,
      timing:{source_started_at:null,source_ended_at:null,source_time_complete:false},
    };
    const group=JSON.stringify([unit.message.message_id,kind,row.topic,row.subject,sources]);
    if(kind==='third_party_fact'&&row.unresolved&&unknownGroups.has(group)){
      const previous=unknownGroups.get(group)!;previous.text+=` 同一原消息续句：“${quote}”`;
      previous.confidence=Math.min(previous.confidence,fact.confidence);previous.risk_flags=[...new Set([...previous.risk_flags,...fact.risk_flags])];
    }else{results.push(fact);if(kind==='third_party_fact'&&row.unresolved)unknownGroups.set(group,fact);}
    contexts.set(unit.id,members.slice(0,-1));contexts.set(unit.id,[...contexts.get(unit.id)!,...deps]);
  }
  requireValid(pending===null);
  return results.map(fact=>timingFromSources(fact,window));
}
function contextsFor(deps:SourceUnit[],_memberGroups:Map<string,SourceUnit[]>,rows:Map<string,Label>):string{
  const notes=deps.map(dep=>`${dep.message.sender==='self'?'用户':'联系人'}说“${dep.text}”`);
  for(const dep of deps)if(rows.get(dep.id)?.unresolved)notes.push('');
  return notes.length?`（相关原文：${notes.filter(Boolean).join('；')}）`:'';
}
function timingFromSources(fact:ExtractedFact,window:ExtractionWindow):ExtractedFact{
  const times=window.messages.filter(message=>fact.source_message_ids.includes(uuid(message.message_id))).map(message=>message.occurred_at);
  const known=times.filter((value):value is string=>value!==null).sort((a,b)=>instantMicros(a)<instantMicros(b)?-1:instantMicros(a)>instantMicros(b)?1:0);
  return {...fact,timing:{source_started_at:known[0]??null,source_ended_at:known.at(-1)??null,source_time_complete:times.every(value=>value!==null)}};
}
export function prepareBoundedForAdoption(fact:ExtractedFact):ExtractedFact{
  if(['joke','sarcasm','hyperbole'].includes(fact.figurative_type)||fact.speech_act==='question')return fact;
  const reasons:string[]=[];if(fact.alternatives.length)reasons.push('ambiguous');if(fact.speech_act!=='assertion')reasons.push(fact.speech_act);
  if(fact.assertion_status!=='asserted')reasons.push(fact.assertion_status);if(fact.figurative_type==='unknown')reasons.push('figurative_unknown');
  return reasons.length?{...fact,risk_flags:[...new Set([...fact.risk_flags,...reasons.map(reason=>`pragmatic:${reason}`)])]}:fact;
}

export function boundedMessages(window:ExtractionWindow):Message[]{
  return window.messages.map(message=>({message_id:uuid(message.message_id),text:message.text,sender:message.sender,
    occurred_at:sourceLocalISO(message),source_snapshots:message.source_snapshots??[]} as Message));
}
export function boundedRepresentation(window:ExtractionWindow,fact:ExtractedFact):Representation|null{
  const messages=boundedMessages(window),targets=(window.target_message_ids??[]).map(uuid),candidate={
    text_content:fact.text,source_ids:fact.source_message_ids,interpretation_reason:fact.interpretation_reason,alternatives:fact.alternatives,
  };
  if(!targets.length||!validateBody(messages,candidate,targets))return null;
  const reps=representations(messages,candidate,targets);return reps.length===1?reps[0]!:null;
}
export function validateBoundedBodySources(window:ExtractionWindow,fact:ExtractedFact):string[]{
  const targets=window.target_message_ids;
  requireValid(Array.isArray(targets)&&targets.length>0&&new Set(targets.map(uuid)).size===targets.length
    &&targets.map(uuid).join(',')===window.messages.filter(message=>targets.map(uuid).includes(uuid(message.message_id))).map(message=>uuid(message.message_id)).join(','));
  requireValid(new Set(fact.source_message_ids).size===fact.source_message_ids.length);
  const rep=boundedRepresentation(window,fact);requireValid(rep);
  const required=new Set([...rep!.main.map(unit=>unit.message.message_id),...rep!.contexts.map(row=>unitKey(row.unit))]);
  requireValid(required.size===fact.source_message_ids.length&&fact.source_message_ids.every(id=>required.has(id)));
  for(const message of window.messages)if(required.has(message.message_id)){
    const anchor=sourceCalendar(message);requireValid(anchor);
    requireValid((message as ExtractionMessage&{message_type?:string}).message_type==='text'&&message.text_representation==='text');
    for(const row of message.source_snapshots??[]){requireValid(typeof row.source_ref_id==='string'&&typeof row.source_id==='string'
      &&uuid(row.source_ref_id)===row.source_ref_id&&uuid(row.source_id)===row.source_id);}
  }
  requireValid([KNOWN_INTERPRETATION,COMPLETED_INTERPRETATION].includes(fact.interpretation_reason));
  requireValid(fact.alternatives.every(value=>value===AMBIGUITY_NOTE));
  return [...required];
}
const unitKey=(unit:Representation['contexts'][number]['unit']):string=>unit.message.message_id;

/** 生成沿用原规则摘要的ALL模式候选；正文未被重建时整批失败。 */
export function bindBoundedFact(window:ExtractionWindow,fact:ExtractedFact):ExtractedFact{
  validateBoundedBodySources(window,fact);
  return {...fact,source_dependency_mode:'all',requires_all_sources:true};
}
