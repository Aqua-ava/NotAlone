import type {BuiltReplyContext} from '../context/reply-context-types.ts';

const nonblank=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
type AdmissibilityContext={
 command?:{content?:Record<string,unknown>};
 risk_notes?:readonly string[];
};

/**
 * 只接受用户要求中显式的结构化未知清单；自由文字和上下文风险同样收紧候选，
 * 不通过关键词猜测某个候选是否虚构。
 */
export function replyCandidateAdmissibility(
  context:AdmissibilityContext,
):{limit:1|3;unknowns:string[]} {
  const instruction=context.command?.content?.user_instruction;
  if(typeof instruction==='string') {
    try{
      const parsed:unknown=JSON.parse(instruction);
      const unknowns=typeof parsed==='object'&&parsed!==null&&!Array.isArray(parsed)
        ?(parsed as Record<string,unknown>).unknowns
        :undefined;
      if(Array.isArray(unknowns)&&unknowns.length>0&&unknowns.every(nonblank))
        return {limit:1,unknowns:unknowns.map(value=>value.trim())};
    }catch{}
  }
  if(context.risk_notes?.length)return {limit:1,unknowns:[...context.risk_notes]};
  return {limit:3,unknowns:[]};
}

export function replyCandidateLimit(context:BuiltReplyContext):1|3 {
  return replyCandidateAdmissibility(context).limit;
}
