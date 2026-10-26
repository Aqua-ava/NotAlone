import type { Client } from 'pg';
import { activeRef } from './contact-overview-evidence.ts';
type Row = Record<string, any>;
export function pythonISO(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.replace(' ', 'T').replace(/Z$/, '+00:00').replace(/([+-]\d\d)$/, '$1:00').replace(/(T\d\d:\d\d)(?=[+-])/, '$1:00');
  return normalized.replace(/\.(\d+)(?=[+-]\d\d:\d\d$)/, (_all, fraction: string) =>
    Number(fraction) ? `.${fraction.padEnd(6, '0').slice(0, 6)}` : '');
}
const TEMPORAL = new RegExp("最近|近来|近期|目前|现在|当下|这月|这个周|这(?:个)?星期|昨天|去年|今年|过去|曾经|当时|那时|之前|正在|暂时|一度|即将");
const STABLE_EXPRESSION = new RegExp("(?:[^是为在于而且并但：:，,；;。.!?！？]{0,16}(?:事实|经历)[：:]\\s*)?(?:(?:对方|联系人|本人|用户|我|他|她|双方|我们|孩子|甲|乙)\\s*)?(?:(?:去年|前年|过去|曾经|当时|以前|之前|曾|已|已经)\\s*)*(?:出生于(?<birth>春天|夏天|秋天|冬天|春季|夏季|秋季|冬季|\\d{4}年|[\\u3400-\\u9fffA-Za-z0-9·-]{1,32}(?:市|省|县|区|乡|镇|村|国|州|岛|郡|城))|出生地(?:为|是)(?<place>[\\u3400-\\u9fffA-Za-z0-9·-]{1,32}(?:市|省|县|区|乡|镇|村|国|州|岛|郡|城))|毕业于(?<school>[\\u3400-\\u9fffA-Za-z0-9·-]{1,32}(?:大学|学院|学校))|已毕业|初次相识|首次见面|(?:拥有|持有)(?:博士|硕士|学士|本科|研究生)?(?:学位|学历)|(?:取得|获得)(?:了)?(?<qualification>[\\u3400-\\u9fffA-Za-z0-9·-]{1,32})?(?:学位|学历|资格))");
const NON_ATOMIC_OBJECT = new RegExp("而|且|并|但|是|在|为|的|当|任职|担任|现在|目前");
const PROSPECTIVE_FACT = new RegExp("计划|打算|准备|预计|即将|将要|可能|如果|假如|希望|想要");
const UNFINISHED_FACT = new RegExp("尚未|还未|还没|没有|并未|并非|不是|不曾|从未|未能|没能|未取得|未获得|未毕业|没毕业");
const FUTURE_FACT = new RegExp("明(?:天|日|早|晚|年)|后(?:天|日|年)|来年|将来|未来|以后|下(?:个)?(?:周|星期|月|季度|半年|年)|将(?:于|会|要)|过(?:几|[一二两三四五六七八九十\\d]+)(?:天|日|周|个月|年)");
const DECLARATION = new RegExp("(?:(?:从|自)\\s*(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:\\d{2}))\\s*(?:到|至)\\s*(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:\\d{2})))|(?:这个月|本月|本周|这周|今天|今日|明天|明日)");
const DATE_FRAGMENT = new RegExp("\\d{4}-\\d{2}(?:-\\d{2})?|\\d{2,4}年|\\d{1,2}月");
const NARROW_TIME = new RegExp("仅|只|部分|有时|偶尔|(?:上|中|下)旬|(?:前|后|上|下)半(?:天|日|月|周)|(?:月|周)(?:初|中|末|底)|(?:早|晚|午)饭|(?:今|明|昨)(?:早|晚|晨|夜)|工作日|(?:周|星期)[一二三四五六日天]|凌晨|清晨|早上|上午|中午|午后|下午|傍晚|晚上|夜间|深夜|白天|夜里|半夜|之前|之后|以前|以后|直到|\\d{1,2}(?:日|号|时|点)|\\d{1,2}:\\d{2}");
const CONFLICTING_TIME = new RegExp("(?:昨|前|后)(?:天|日)|(?:上|下)(?:个)?(?:月|周|星期|季度|年)|(?:去|前|今)年|过去|曾经|当时|那时|之前|最近|近期|近来");
const unknownReason = '当前未核实；原话和保存时间不能证明状态现在仍成立。';
function stableFact(text: string): boolean {
  if ([PROSPECTIVE_FACT,UNFINISHED_FACT,FUTURE_FACT].some(re=>re.test(text))) return false;
  const claims = text.split(/[，,；;。!?！？]+|但是|但|同时|并且|且/).map(s=>s.trim()).filter(Boolean);
  return claims.length > 0 && claims.every(claim=> {
    const match = new RegExp(`^(?:${STABLE_EXPRESSION.source})$`).exec(claim);
    if (!match || Object.values(match.groups ?? {}).some(value=>value && NON_ATOMIC_OBJECT.test(value))) return false;
    const birth = match.groups?.birth;
    return !birth || !/^\d{4}年$/.test(birth) || Number(birth.slice(0,-1)) <= new Date().getUTCFullYear();
  });
}
function timeScoped(text: string): boolean { return [DECLARATION,FUTURE_FACT,DATE_FRAGMENT,CONFLICTING_TIME].some(re=>re.test(text)); }
export function epochMicros(value: string): bigint {
  const normalized=pythonISO(value)!;
  const fraction=/\.(\d+)/.exec(normalized)?.[1]??'';
  return BigInt(Date.parse(normalized))*1000n+BigInt(fraction.padEnd(6,'0').slice(3,6));
}
function offset(value: string): number {
  const match = /([+-])(\d\d):(\d\d)$/.exec(value);
  return match ? (match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]))*60000 : 0;
}
function localISO(milliseconds: number, zone: number): string {
  return new Date(milliseconds+zone).toISOString().replace('.000Z',`${zone<0?'-':'+'}${String(Math.floor(Math.abs(zone)/3600000)).padStart(2,'0')}:${String(Math.abs(zone)/60000%60).padStart(2,'0')}`);
}
function interval(text: string, anchor: string | null): [number,number,string,string] | null {
  const matches = [...text.matchAll(new RegExp(DECLARATION.source,'g'))];
  if(matches.length!==1) return null;
  const match=matches[0], remainder=text.slice(0,match.index)+text.slice(match.index!+match[0].length);
  if(timeScoped(remainder)||NARROW_TIME.test(remainder)) return null;
  if(match[1]) { const a=Date.parse(match[1]),b=Date.parse(match[2]); return a<b?[a,b,pythonISO(match[1])!,pythonISO(match[2])!]:null; }
  if(!anchor) return null;
  const zone=offset(anchor),local=new Date(Date.parse(anchor)+zone);
  let a=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-zone,b:number;
  if(['这个月','本月'].includes(match[0])) { a=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),1)-zone; b=Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,1)-zone; }
  else if(['本周','这周'].includes(match[0])) { a-=((local.getUTCDay()+6)%7)*86400000;b=a+7*86400000; }
  else { if(['明天','明日'].includes(match[0])) a+=86400000;b=a+86400000; }
  return [a,b,localISO(a,zone),localISO(b,zone)];
}
export async function projectTiming(client: Client,row:Row,scope: 'contact'|'owner' = 'contact'):Promise<Row> {
  const rows=(await client.query(`SELECT message.id,message.occurred_at::text AS occurred_at,message.text_content,
    ARRAY(SELECT ref.raw_payload->>'time_iso' FROM public.message_source_ref ref
      WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ${activeRef}) AS source_times
    FROM public.message message WHERE message.owner_id=$1 AND ($4::boolean OR message.contact_id=$2) AND message.id=ANY($3::uuid[])
    AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id
      AND ref.contact_id=message.contact_id AND ${activeRef})`,[row.owner_id,row.contact_id??null,row.source_ids,scope==='owner'])).rows;
  const known=new Map<string,{time:string|null;anchor:string|null;text:string}>();
  for(const item of rows) {
    const anchors:string[]=item.source_times.filter((value:any)=>item.occurred_at!==null && typeof value==='string' && /(Z|[+-]\d\d:\d\d)$/.test(value)
      && Number.isFinite(Date.parse(value)) && epochMicros(value)===epochMicros(item.occurred_at));
    const anchor=anchors.length && new Set(anchors.map(offset)).size===1?pythonISO(anchors[0]):null;
    known.set(item.id,{time:anchor??pythonISO(item.occurred_at),anchor,text:item.text_content});
  }
  const times:string[]=row.source_ids.map((id:string)=>known.get(id)?.time).filter(Boolean);
  times.sort((a,b)=>epochMicros(a)<epochMicros(b)?-1:epochMicros(a)>epochMicros(b)?1:0);
  const timing:Row={recorded_at:pythonISO(row.created_at),source_started_at:times[0]??null,source_ended_at:times.at(-1)??null,
    source_time_complete:row.source_ids.length>0&&times.length===row.source_ids.length,current_status:'current_unverified',current_status_reason:unknownReason};
  const now=Date.now(), start=row.valid_at?Date.parse(row.valid_at):null,end=row.invalid_at?Date.parse(row.invalid_at):null;
  const set=(status:string,reason:string)=>({...timing,current_status:status,current_status_reason:reason});
  if(end!==null&&now>=end) return set('historical','已离开资料声明的可引用区间；只保留历史，不据此认定约定完成或现实状态结束。');
  if(row.conditions) return set('current_unverified','附适用条件；来源只支持当时的条件表达，当前是否满足未知。');
  if(start!==null&&now<start) return set('current_unverified','声明区间尚未开始；当前未核实。');
  const completed=row.category==='common_fact'&&stableFact(row.text_content);
  let stable=['preference','taboo'].includes(row.category)||completed;
  if(!completed&&(timeScoped(row.text_content)||TEMPORAL.test(row.text_content)||PROSPECTIVE_FACT.test(row.text_content)
    ||FUTURE_FACT.test(row.text_content)||(row.category==='common_fact'&&UNFINISHED_FACT.test(row.text_content)))) stable=false;
  const statements=row.source_ids.map((id:string)=>known.get(id)).filter(Boolean) as {text:string;anchor:string|null}[];
  const intervals=statements.map(item=>interval(item.text,item.anchor)),claims=statements.map(item=>interval(row.text_content,item.anchor));
  const first=intervals[0];
  if(!stable&&end!==null&&timing.source_time_complete&&first&&intervals.every(i=>i&&i[0]===first[0]&&i[1]===first[1])
    &&claims.every(i=>i&&i[0]===first[0]&&i[1]===first[1])) {
    const lower=start??first[0];
    if(first[1]===end&&first[0]<=lower&&lower<end&&lower<=now&&now<end&&Date.parse(timing.source_ended_at)<=now)
      return set('current_verified',`直接来源支持当期区间 [${start!==null?pythonISO(row.valid_at):first[2]}, ${first[3]})；仅核实原话的时间适用范围，不认证现实真伪。`);
  }
  return set(stable?'stable':'current_unverified',stable?'稳定事实或明确偏好；继续受来源、采纳和有效期约束，不因日期未知降级。':row.category==='common_fact'?'无法从资料判定这项共同事实是否稳定持续；当前未核实，保存时间不证明现在仍成立。':unknownReason);
}
