import {useEffect,useRef,useState} from 'react';
import type {SqliteDiscussionBridge,SqliteDiscussionReceipt} from '../shared/sqlite-discussion-bridge';
import {readSqliteCandidatePage,readSqliteCandidateVersion,type SqliteCandidatePage,type SqliteCandidateVersion,type SqliteCandidateOperation} from '../shared/sqlite-reply-candidates';
interface Props {bridge:SqliteDiscussionBridge;contactId:string|null;scopeRevision:number;sessionId:string|null;disabled?:boolean;initialDraft?:string;onInitialDraftTaken?:()=>void;onSubmitted?:(receipt:SqliteDiscussionReceipt)=>void}
/** 草稿、候选、依据和实际Skill快照共用同一失效边界；迟到回包不能重新挂回旧正文。 */
export function SqliteReplyCandidatesPanel({bridge,contactId,scopeRevision,sessionId,disabled=false,initialDraft='',onInitialDraftTaken,onSubmitted}:Props){
 const scopeKey=JSON.stringify([contactId,scopeRevision,sessionId]),latest=useRef({scopeKey,bridge,disabled});latest.current={scopeKey,bridge,disabled};
 const revision=useRef(0),mounted=useRef(false),operation=useRef<object|null>(null);
 const retry=useRef<{fingerprint:string;requestKey:string}|null>(null);
 const seeded=useRef<string|null>(null);
 const qualifiedRequests=useRef<string[]>([]);
 const [page,setPage]=useState<SqliteCandidatePage|null>(null),[draft,setDraft]=useState(''),[carry,setCarry]=useState<string|undefined>();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [edits,setEdits]=useState<Record<string,string[]>>({}),[inspected,setInspected]=useState<Record<string,SqliteCandidateVersion>>({});
 const available=!!bridge.candidates&&!!contactId&&!!sessionId&&!disabled;
 function clear(){++revision.current;operation.current=null;retry.current=null;qualifiedRequests.current=[];setPage(null);setDraft('');setCarry(undefined);setBusy(false);setError('');setNotice('');setEdits({});setInspected({});}
 useEffect(()=>{mounted.current=true;const off=bridge.onInvalidated(()=>{seeded.current=scopeKey;clear();});return()=>{mounted.current=false;++revision.current;operation.current=null;off();};},[bridge,scopeKey]);
 useEffect(()=>{clear();if(available){if(seeded.current!==scopeKey){seeded.current=scopeKey;setDraft(initialDraft);if(initialDraft)onInitialDraftTaken?.();}void run({action:'read'});}},[scopeKey,bridge,disabled]);
 type Command=SqliteCandidateOperation extends infer O?O extends SqliteCandidateOperation?Omit<O,'contactId'|'scopeRevision'|'sessionId'>:never:never;
 function showPage(next:SqliteCandidatePage){
  // 仅保留无正文的来源标识，短暂读取失败后仍能核对旧草稿的资格。
  const readable=qualifiedRequests.current;
  if(readable.some(id=>!next.requests.some(r=>r.requestId===id&&r.sourceState==='available'))){
   setDraft('');setCarry(undefined);retry.current=null;setNotice('');
  }
  qualifiedRequests.current=next.requests.filter(r=>r.sourceState==='available'&&r.candidates.length).map(r=>r.requestId);
  setPage(next);setEdits({});setInspected({});
 }
 function rejectOperation(error:unknown){
  const text=error instanceof Error?error.message:'候选结果尚未确认，请重新读取。';
  setEdits({});setInspected({});setNotice('');
  if(/失效|已变化|已不可用|请先确认/.test(text)){
   qualifiedRequests.current=[];setPage(null);setDraft('');setCarry(undefined);retry.current=null;
  }else setPage(old=>old?{coverage:old.coverage,requests:[]}:null);
  setError(text);
 }
 async function run(command:Command){
  if(!available||!bridge.candidates||!contactId||!sessionId||operation.current)return;
  const token={},boundary=revision.current;operation.current=token;setBusy(true);setError('');
  const current=()=>mounted.current&&operation.current===token&&revision.current===boundary&&latest.current.scopeKey===scopeKey&&latest.current.bridge===bridge&&!latest.current.disabled;
  const scope={contactId,scopeRevision,sessionId};
  try{
   const response=await bridge.candidates.execute({...scope,...command} as SqliteCandidateOperation);if(!current())return;
   if(command.action==='read'){showPage(readSqliteCandidatePage(response));}
   else if(command.action==='version')setInspected(v=>({...v,[command.candidateId]:readSqliteCandidateVersion(response)}));
   else{
    if(command.action==='generate'){
     const r=response as {session_id:string;request_key:string;segmented:boolean;replayed:boolean};
     if(r.request_key!==command.requestKey||typeof r.session_id!=='string'||typeof r.segmented!=='boolean'||typeof r.replayed!=='boolean')throw new Error('候选结果尚未确认，请保留原请求重试核对。');
     retry.current=null;setDraft('');setCarry(undefined);setNotice(r.replayed?'已定位原请求，候选已重新核对。':'候选已保存，最终消息请自行发送。');
     onSubmitted?.({sessionId:r.session_id,requestKey:r.request_key,segmented:r.segmented,replayed:r.replayed});
     if(r.session_id!==sessionId)return;
    }else if(command.action==='select'){
     const selection=response as {id:string};if(typeof selection.id!=='string')throw new Error('选稿结果尚未确认，请重新读取。');
     setNotice(`已选用第${command.versionNo}版；选用不表示已发送。`);
    }else setNotice('修改已保存为新版本，继承依据尚未重新核验。');
    const next=await bridge.candidates.execute({...scope,action:'read'});if(!current())return;showPage(readSqliteCandidatePage(next));
   }
  }catch(e){if(current())rejectOperation(e);}
  finally{if(current()){operation.current=null;setBusy(false);}}
 }
 async function generate(){
  if(!draft.trim()||!page)return;
  const fingerprint=JSON.stringify({draft,carry}),requestKey=retry.current?.fingerprint===fingerprint?retry.current.requestKey:crypto.randomUUID();retry.current={fingerprint,requestKey};
  await run({action:'generate',requestKey,text:draft,acceptIncomplete:false,...(carry?{carriedSelectionId:carry}:{})});
 }
 async function continueVersion(v:SqliteCandidateVersion){
  if(!available||!bridge.candidates||!contactId||!sessionId||operation.current)return;
  const token={},boundary=revision.current;operation.current=token;setBusy(true);setError('');
  const current=()=>mounted.current&&operation.current===token&&revision.current===boundary&&latest.current.scopeKey===scopeKey&&latest.current.bridge===bridge&&!latest.current.disabled;
  try{const result=await bridge.candidates.execute({contactId,scopeRevision,sessionId,action:'select',candidateId:v.candidateId,versionNo:v.versionNo}) as {id:string};if(current()){if(typeof result.id!=='string')throw new Error('选稿结果尚未确认。');setCarry(result.id);setNotice(`下一次明确请求将继续第${v.versionNo}版候选。`);}}
  catch(e){if(current())rejectOperation(e);}
  finally{if(current()){operation.current=null;setBusy(false);}}
 }
 return <section aria-label="候选回复" className="sqlite-reply-candidates">
  <h3>候选回复</h3><p>写下本次想法，查看依据后选择或修改。最终消息由你亲自发送。</p>
  {!available&&<p role="status">请先确认联系人并明确继续当前助手讨论。</p>}
  <label>本次想法<textarea aria-label="本次想法" value={draft} maxLength={100000} disabled={!available||busy} onChange={e=>setDraft(e.target.value)} /></label>
  <button disabled={!available||busy||!page||!draft.trim()} onClick={()=>void generate()}>{busy?'正在处理候选…':retry.current?'重试核对候选':'生成候选'}</button>
  <button disabled={!available||busy} onClick={()=>void run({action:'read'})}>重新读取候选</button>
  {carry&&<button disabled={busy} onClick={()=>{setCarry(undefined);setNotice('已取消本次候选继续。');}}>取消候选继续</button>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {page?.requests.map(request=><div key={request.requestId} className="sqlite-candidate-request">
   {request.skillWarning&&<p role="status">{request.skillWarning}</p>}
   {request.loadedSkills.find(s=>s.relativePath==='SKILL.md')?.name&&<p>本次策略：{request.loadedSkills.find(s=>s.relativePath==='SKILL.md')!.name}</p>}
   {request.coverageWarning&&<p role="status">{request.coverageWarning}</p>}
   {request.generationState==='unknown'&&<p role="status">本次模型调用结果未知，请核对原请求，不能换身份重发。</p>}
   {request.generationState==='failed'&&<p role="status">本次候选生成失败，没有可选正文。</p>}
   {request.sourceState==='unavailable'&&(!request.generationState||request.generationState==='committed'||request.generationState==='invalidated')&&<p role="status">这次候选的来源已失效，正文与依据已撤下。</p>}
   {request.candidates.map(candidate=>{const v=inspected[candidate.candidateId]??candidate,parts=edits[v.candidateId]??v.parts;return <article key={v.candidateId} aria-label={`候选第${request.candidates.indexOf(candidate)+1}组`}>
    <h4>候选第{request.candidates.indexOf(candidate)+1}组 · 第{v.versionNo}版{v.origin==='manual'?'（手工编辑）':''}</h4>
    {parts.map((part,index)=><label key={index}>第{index+1}条<textarea aria-label={`候选第${index+1}条`} value={part} disabled={busy||!available} onChange={e=>setEdits(old=>({...old,[v.candidateId]:parts.map((p,n)=>n===index?e.target.value:p)}))} /></label>)}
    <button disabled={busy||!available||!edits[v.candidateId]} onClick={()=>void run({action:'edit',candidateId:v.candidateId,versionNo:v.versionNo,parts})}>保存修改</button>
    <button disabled={busy||!available} onClick={()=>void run({action:'select',candidateId:v.candidateId,versionNo:v.versionNo})}>选用此版本</button>
    <button disabled={busy||!available} onClick={()=>void continueVersion(v)}>以此版本继续</button>
    {v.versionNo>1&&<button disabled={busy} onClick={()=>void run({action:'version',candidateId:v.candidateId,versionNo:v.versionNo-1})}>查看上一版</button>}
    {v.versionNo!==candidate.versionNo&&<button disabled={busy} onClick={()=>{setInspected(old=>{const next={...old};delete next[v.candidateId];return next;});setEdits({});}}>回到最新版本</button>}
    <details><summary>依据</summary>{v.basis.map(b=><div key={b.itemNo}><p>{b.verification==='inherited_unverified'?'继承原依据，手工修改尚未重新核验':'产生此模型版本的实际输入'} · {({message:'聊天原文',entry:'本次讨论',memory:'已采纳记忆',memory_candidate:'未确认记忆',document:'已发布资料',selection:'明确选稿',coverage:'历史覆盖'} as Record<string,string>)[b.kind]??'实际资料'}</p><p className="discussion-entry-text">{b.text}</p></div>)}</details>
   </article>;})}
   {!!request.loadedSkills.length&&<details><summary>本次实际载入的 Skill</summary>{request.loadedSkills.map((s,index)=><div key={index}><p>第{s.revisionNo}版 · {s.relativePath}</p><p>{s.text}</p></div>)}</details>}
   {!!request.selections.length&&<p>已记录{request.selections.length}次选稿，最近选用第{request.selections.at(-1)!.versionNo}版。</p>}
  </div>)}
 </section>;
}
