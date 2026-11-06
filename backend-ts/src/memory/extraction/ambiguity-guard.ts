/**
 * 确定性易歧义兜底：只做字面规则，且仅在候选 alternatives 为空时命中。
 * 命中用于把候选降级为待确认（不自动采纳、不发布），不修改正文、不调用模型、不新增外发。
 * 规则刻意保守（宁少勿滥），只识别两类结构：
 * 1. 数量词省略单位：独立的阿拉伯数字/中文大数没有单位、量词，也没有相邻类别词可判定它是什么量；
 * 2. 指代词无同条所指：第三人称代词或指示词在候选正文与解释里都没有可唯一确定的所指。
 * 只覆盖有明确字面特征的子集；漏检的候选仍走原有核验与裁决，不扩大拦截面。
 */
export const AMBIGUITY_UNCONFIRMED='memory_ambiguity_unconfirmed';
export type AmbiguityRule='quantity_without_unit'|'unresolved_reference';
export interface AmbiguitySignal{rule:AmbiguityRule;token:string}
export interface AmbiguityCandidate{text:string;interpretationReason?:string|null;alternatives?:unknown}
/** 数字后紧跟这些单位/量词时视为已限定，不再按「缺少单位」处理。 */
const QUANTITY_UNITS=['块钱','个小时','小时','分钟','公斤','千克','公里','平米','平方','星期','个月','左右','上下','个百分点',
 '元','块','角','毛','分','岁','年','月','天','日','号','点','时','周','秒','个','位','人','家','件','份','条','张','本','杯','瓶','包','袋','套','台','辆','级','楼','层','班','次','倍','成','折','米','斤','克','度','篇','章','集','期','届','门','科','项','笔','单','抽','根','支','双','对','只','头','匹','亩','升','吨','万','亿','千','百','十','多','余','来','%','％'];
/** 数字邻近出现这些类别词时，数量属于什么已经可判定（仍可能是别的歧义，但不属于本规则）。 */
const QUANTITY_CATEGORIES=['工资','房租','奖金','收入','房贷','车贷','彩礼','红包','转账','存款','余额','价格','费用','押金','租金','利息','学费','机票','生活费','年终奖','提成','分红','借款','欠款','账单','月薪','年薪','时薪','日薪','绩效','金额','开销','花费','预算'];
/** 不是数量的常见数字（院校层次、工作制等），不按独立数字处理。 */
const NON_QUANTITY_NUMBERS=new Set(['985','211','996','007','911','110','120','119','114']);
/** 数字前是这些字/符号时才按「独立数量」看待：函数词、动词、标点或空白。 */
const QUANTITY_LEAD_CHARS='是为到了有约近超过达给花赚拿换存省借还发收付值长高多少共总余剩差欠补交赔罚捐投挣攒用要能会可需应让使被把将于在从比仅只就才又再也都';
/** 人称谓词表；用于判断代词是否还有另一个可能的所指。 */
const PERSON_NOUNS=['哥哥','弟弟','姐姐','妹妹','朋友','同事','领导','老师','同学','亲戚','父母','妈妈','爸爸','房东','闺蜜',
 '男朋友','女朋友','男友','女友','老公','老婆','儿子','女儿','叔叔','阿姨','舅舅','姑姑','爷爷','奶奶','外公','外婆',
 '表哥','表姐','表妹','堂哥','堂弟','堂姐','堂妹','室友','老板','客户','导师','导员','医生','护士','师傅','邻居','发小',
 '家人','对象','前任','姐夫','嫂子','弟妹','妹夫','侄子','侄女','外甥','岳父','岳母','公公','婆婆','上司','下属','组长','经理','总监','合伙人','中介'];
const PRONOUNS=/[他她](?:们)?/gu;
const DEMONSTRATIVES=/(?:那个|这个|那些|这些|那笔|这笔|那位|这位)/gu;
const DEMONSTRATIVE_LOOSE=/^(?:[，。；：！？、）)】]|$|是|就|也|都|要|会|能|让|给|已|还|又|再|没|不|怎|为|真|太|挺|到|在)/u;
const isSpace=(value:string|undefined):boolean=>value!==undefined&&/^\s$/u.test(value);
function previousVisible(text:string,index:number){let i=index-1;while(i>=0&&isSpace(text[i]))i--;return i>=0?text[i]!:'';}
function nextVisibleIndex(text:string,index:number){let i=index;while(i<text.length&&isSpace(text[i]))i++;return i;}
function quantityLead(previous:string):boolean{return previous===''||/[\s，。；：！？、（）()【】\[\]“”‘’"'《》…—\-·]/u.test(previous)||QUANTITY_LEAD_CHARS.includes(previous);}
function adjacentCategory(text:string,start:number,end:number):boolean{
 const before=text.slice(Math.max(0,start-6),start),after=text.slice(end,end+6);
 return QUANTITY_CATEGORIES.some(category=>before.includes(category)||after.includes(category));
}
/** 只保留不重叠的人称谓词命中，避免「男朋友」同时被算成「朋友」。 */
function distinctPersonNouns(text:string):string[]{
 const spans:[number,number,string][]=[];
 for(const noun of [...PERSON_NOUNS].sort((left,right)=>right.length-left.length)){
  let from=0,found=text.indexOf(noun,from);
  while(found>=0){
   const end=found+noun.length;
   if(!spans.some(([start,stop])=>found<stop&&start<end))spans.push([found,end,noun]);
   from=end;found=text.indexOf(noun,from);
  }
 }
 return [...new Set(spans.map(([, ,noun])=>noun))];
}
function quantitySignal(text:string):AmbiguitySignal|null{
 const normalized=text.replace(/[０-９]/gu,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0));
 for(const match of normalized.matchAll(/\d+(?:\.\d+)?/gu)){
  const token=match[0],start=match.index,end=start+token.length;
  if(NON_QUANTITY_NUMBERS.has(token)||/^(?:19|20)\d\d$/u.test(token))continue;
  const previous=normalized[start-1]??'',following=normalized[end]??'';
  if(/[A-Za-z0-9]/u.test(previous)||/[A-Za-z0-9]/u.test(following))continue;
  if(':/：'.includes(previous)||':/：'.includes(following)||'~—至到-'.includes(previous)||'~—至到-'.includes(following))continue;
  if(!quantityLead(previousVisible(normalized,start)))continue;
  const rest=normalized.slice(nextVisibleIndex(normalized,end));
  if(QUANTITY_UNITS.some(unit=>rest.startsWith(unit)))continue;
  if(adjacentCategory(normalized,start,end))continue;
  return {rule:'quantity_without_unit',token};
 }
 for(const match of normalized.matchAll(/[一二三四五六七八九两][千万亿]/gu)){
  const token=match[0];
  if(token==='千万')continue;
  const start=match.index,end=start+token.length;
  if(!quantityLead(previousVisible(normalized,start)))continue;
  const rest=normalized.slice(nextVisibleIndex(normalized,end));
  if(QUANTITY_UNITS.some(unit=>rest.startsWith(unit)))continue;
  if(adjacentCategory(normalized,start,end))continue;
  return {rule:'quantity_without_unit',token};
 }
 // 程度/数量模糊且没有单位：多赚点、换点钱一类，属于数量词省略单位的子集。
 const vague=normalized.match(/(?:多|少)(?:赚|挣|攒|存)(?:点|些)/u)??normalized.match(/[赚挣花攒存省给发拿换](?:点|些)(?:钱|款|工资|收入|红包|利息|奖金|积蓄|存款)/u);
 return vague?{rule:'quantity_without_unit',token:vague[0]}:null;
}
function referenceSignal(text:string,reason:string):AmbiguitySignal|null{
 const combined=reason?`${text}\n${reason}`:text,nouns=distinctPersonNouns(text);
 for(const match of combined.matchAll(PRONOUNS)){
  const token=match[0],index=match.index,previous=combined[index-1]??'',next=combined[index+token.length]??'';
  if('其吉利排无任'.includes(previous)||'人乡日处方'.includes(next)||next==='（'||next==='(')continue;
  if(index<text.length){
   // 正文必须独立完整：未消解的第三人称代词只有在没有唯一先行词（0 或 ≥2 个不同人物）时才降级。
   if(nouns.length!==1)return {rule:'unresolved_reference',token};
  }else if(nouns.length>=2){
   // 解释里仍保留原话代词、正文又出现多个可能所指：合并只补了细节，没有消解指代。
   return {rule:'unresolved_reference',token};
  }
 }
 for(const match of combined.matchAll(DEMONSTRATIVES)){
  if(DEMONSTRATIVE_LOOSE.test(combined.slice(match.index+match[0].length)))return {rule:'unresolved_reference',token:match[0]};
 }
 return null;
}
/** 字面结构命中；不检查 alternatives，供规则单测与诊断直接调用。 */
export function ambiguitySignal(input:AmbiguityCandidate):AmbiguitySignal|null{
 const text=typeof input.text==='string'?input.text:'';
 if(!text.trim())return null;
 return quantitySignal(text)??referenceSignal(text,typeof input.interpretationReason==='string'?input.interpretationReason:'');
}
/** 采纳/裁决前置兜底：alternatives 非空说明不确定性已被标注，保持原逻辑不降级。 */
export function unconfirmedAmbiguity(input:AmbiguityCandidate):AmbiguitySignal|null{
 if(Array.isArray(input.alternatives)&&input.alternatives.length)return null;
 return ambiguitySignal(input);
}
