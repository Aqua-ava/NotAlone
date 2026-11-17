import {memo,useEffect,useRef,useState} from 'react';
import {readSqliteCandidateInputPage,readSqliteCandidateSkillPage,type SqliteCandidateInputMaterial,type SqliteCandidateInputPage,type SqliteCandidateSkillPage,type SqliteCandidateRequest,type SqliteCandidateScope,type SqliteReplyCandidatesBridge,type SqliteCandidateVersion} from '../shared/sqlite-reply-candidates';

type Material=SqliteCandidateInputMaterial;
function category(item:Material):string{
 if(item.kind==='message')return '聊天原文';
 if(item.kind==='entry')return '本次输入与讨论';
 if(item.kind==='selection')return '选用的候选';
 if(item.kind==='coverage')return '历史覆盖说明';
 if(item.scopeKind==='owner')return '本人资料';
 if(['memory','memory_candidate','document'].includes(item.kind))return item.scopeKind==='contact'?'关系资料':'记忆与资料（归属未记录）';
 return '其他资料';
}
function materialLabel(item:Material):string{
 if(item.workspaceItem)return ({request:'本次动作与设置',draft:'想法／草稿',instruction:'一次性要求',supplemental_context:'补充聊天背景'})[item.workspaceItem];
 if(item.projectionKind==='directory')return '资料目录（非正文）';
 if(item.projectionKind==='profile')return '长期背景';
 if(item.projectionKind==='blocks')return '场景正文';
 if(item.kind==='memory_candidate'||item.qualification==='unconfirmed')return '未确认记忆';
 if(item.kind==='memory')return item.qualification==='auto'?'自动采纳记忆':'已采纳记忆';
 if(item.kind==='document')return '已发布资料';
 return '';
}
/** 展示快照原文，不解析或改写时间、作者及原文中的标记。 */
export function CandidateMaterialGroups({items}:{items:Material[]}){
 const groups=new Map<string,Material[]>();
 for(const item of items){const name=category(item),group=groups.get(name);if(group)group.push(item);else groups.set(name,[item]);}
 return <div className="candidate-reference-groups">{[...groups].map(([name,materials])=><details className="candidate-reference-group" key={name} open={name==='聊天原文'}>
  <summary>{name} · {materials.length} 项</summary>
  <div className="candidate-reference-scroll">{materials.map(item=><div className={`candidate-reference-item${item.kind==='message'?' candidate-reference-chat':''}`} key={item.itemNo}>
   <span className="candidate-reference-meta">#{item.itemNo}{materialLabel(item)&&` · ${materialLabel(item)}`}{item.versionNo&&` · 第 ${item.versionNo} 版`}</span>
   <p className="discussion-entry-text">{item.text}</p>
  </div>)}</div>
 </details>)}</div>;
}
export const CandidateBasis=memo(function CandidateBasis({version}:{version:SqliteCandidateVersion}){
 const inherited=version.basis.some(item=>item.verification==='inherited_unverified');
 return <details className="candidate-basis" key={`${version.candidateId}:${version.versionNo}`}><summary><span>依据</span><small> · 引用 {version.basis.length} 项</small></summary>
  <p className="candidate-reference-note">这条说法引用的资料；其他资料及 Skill 见「本次参考」。</p>
  {inherited&&<p className="candidate-reference-note" role="status">继承原依据，手工修改尚未重新核验</p>}
  <CandidateMaterialGroups items={version.basis}/>
 </details>;
});
interface Props {bridge:SqliteReplyCandidatesBridge;scope:SqliteCandidateScope;request:SqliteCandidateRequest;disabled:boolean;onUnavailable:()=>void}
/** 只在展开时读当前请求；关闭、换快照或失效后的迟到正文不再展示。 */
export function SqliteCandidateReferences({bridge,scope,request,disabled,onUnavailable}:Props){
 const [open,setOpen]=useState(false),[skillOpen,setSkillOpen]=useState(false);
 const [inputs,setInputs]=useState<SqliteCandidateInputPage|null>(null),[skills,setSkills]=useState<SqliteCandidateSkillPage|null>(null);
 const [loading,setLoading]=useState<'inputs'|'skills'|null>(null),[error,setError]=useState('');
 const generation=useRef(0),mounted=useRef(false);
 const referenceItems=inputs?.items.filter(item=>item.kind!=='message')??[];
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;++generation.current;};},[]);
 async function load(kind:'inputs'|'skills',offset=0){
  if(disabled||loading)return;
  const token=++generation.current;setLoading(kind);setError('');
  try{
   const response=await bridge.execute({...scope,requestId:request.requestId,action:kind,offset});
   if(!mounted.current||generation.current!==token)return;
   if(kind==='inputs'){
    const page=readSqliteCandidateInputPage(response,offset);
    setInputs(old=>({...page,items:offset&&old?[...old.items,...page.items]:page.items}));
   }else{
    const page=readSqliteCandidateSkillPage(response,offset);
    setSkills(old=>({...page,items:offset&&old?[...old.items,...page.items]:page.items}));
   }
  }catch(cause){
   if(!mounted.current||generation.current!==token)return;
   setInputs(null);setSkills(null);
   const message=cause instanceof Error?cause.message:'参考资料暂未读取，请重试。';
   if(/失效|已变化|已不可用|请先确认|重新核验|资格/.test(message)){onUnavailable();return;}
   setError('参考资料暂未读取，请重试。');
  }finally{if(mounted.current&&generation.current===token)setLoading(null);}
 }
 function toggle(next:boolean){
  if(next===open)return;setOpen(next);
  if(next)void load('inputs');
  else{++generation.current;setLoading(null);setInputs(null);setSkills(null);setSkillOpen(false);setError('');}
 }
 return <details className="candidate-references" open={open} onToggle={event=>toggle(event.currentTarget.open)}>
  <summary><span>本次参考</span><small> · 资料与 Skill</small></summary>
  {open&&<>
   <p className="candidate-reference-note">本次输入与资料按类别展示，Skill 单独查看；引用的聊天原文见各自「依据」。</p>
   {inputs?.recorded===false&&<p role="status">这次实际输入记录缺失，无法还原参考资料。</p>}
   {inputs?.recorded&&<>
    <CandidateMaterialGroups items={referenceItems}/>
    {!inputs.total&&<p className="candidate-reference-note">本次未记录资料输入。</p>}
    <p className="candidate-reference-note">已显示 {referenceItems.length} 项参考资料</p>
    {inputs.nextOffset!==null&&<button className="button" disabled={disabled||!!loading} onClick={()=>void load('inputs',inputs.nextOffset!)}>加载更多输入</button>}
   </>}
   {loading&&<p role="status" className="candidate-reference-note">正在读取{loading==='inputs'?'实际输入':' Skill 正文'}…</p>}
   {error&&<p role="alert">{error}</p>}
   {(!inputs&&!loading)&&<button className="button" disabled={disabled} onClick={()=>void load('inputs')}>重试读取参考</button>}
   <details className="candidate-reference-group" open={skillOpen} onToggle={event=>{const next=event.currentTarget.open;if(next===skillOpen)return;setSkillOpen(next);if(next&&!skills&&request.loadedSkills.length)void load('skills');}}>
    <summary>Skill · 实际读取（{request.loadedSkills.length} 份）</summary>
    {skillOpen&&<>
     <p className="candidate-reference-note">以下正文和资源曾实际载入，用于指导表达方法；可选目录不代表已读取。历史可选目录未在此记录。</p>
     {!request.loadedSkills.length&&<p className="candidate-reference-note">本次未读取 Skill 正文或资源。</p>}
     {!!skills?.items.length&&<div className="candidate-reference-scroll">{skills.items.map((skill,index)=><details className="candidate-skill-file" key={`${skill.packageId}:${skill.revisionNo}:${skill.relativePath}:${index}`}>
      <summary>{request.loadedSkills.find(item=>item.packageId===skill.packageId&&item.revisionNo===skill.revisionNo)?.title??skill.title??skill.name??'未命名 Skill'} · 第 {skill.revisionNo} 版 · {skill.relativePath}</summary>
      <p className="candidate-reference-meta">{skill.origin==='explicit'?'用户指定':skill.origin==='auto_preload'?'自动预载':'模型按需读取'}</p>
      <p className="discussion-entry-text">{skill.text}</p>
     </details>)}</div>}
     {skills?.nextOffset!=null&&<button className="button" disabled={disabled||!!loading} onClick={()=>void load('skills',skills.nextOffset!)}>加载更多 Skill</button>}
     {!skills&&request.loadedSkills.length>0&&!loading&&<button className="button" disabled={disabled} onClick={()=>void load('skills')}>读取 Skill 正文</button>}
    </>}
   </details>
  </>}
 </details>;
}
