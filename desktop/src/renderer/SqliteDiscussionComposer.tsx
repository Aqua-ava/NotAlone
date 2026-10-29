import {useEffect,useRef,useState,type FormEvent} from 'react';
import {SQLITE_DISCUSSION_MAX_TEXT_LENGTH} from '../shared/sqlite-discussion-bridge';
import type {SqliteDiscussionBridge,SqliteDiscussionReceipt} from '../shared/sqlite-discussion-bridge';
export interface SqliteDiscussionComposerProps {
 bridge:SqliteDiscussionBridge;contactId:string|null;scopeRevision:number;sessionId:string|null;disabled?:boolean;
 onSubmitted?:(receipt:SqliteDiscussionReceipt)=>void;
}
/** 讨论草稿只属于当前范围；失效事件撤下草稿与回执，未知结果的显式重试保留同一请求。 */
export function SqliteDiscussionComposer({bridge,contactId,scopeRevision,sessionId,disabled=false,onSubmitted}:SqliteDiscussionComposerProps){
 const scopeKey=JSON.stringify([contactId,scopeRevision,sessionId]),latest=useRef({scopeKey,bridge});latest.current={scopeKey,bridge};
 const mounted=useRef(false),revision=useRef(0),inFlight=useRef<object|null>(null);
 const attempt=useRef<{scopeKey:string;text:string;requestKey:string}|null>(null);
 const [draft,setDraft]=useState<{scopeKey:string;text:string}|null>(null);
 const [pending,setPending]=useState<string|null>(null),[error,setError]=useState<{scopeKey:string;text:string}|null>(null);
 const [completed,setCompleted]=useState<{scopeKey:string;receipt:SqliteDiscussionReceipt}|null>(null);
 const text=draft?.scopeKey===scopeKey?draft.text:'',busy=pending===scopeKey,failed=error?.scopeKey===scopeKey;
 const enabled=!!contactId&&!!sessionId&&!disabled;
 function clear(){++revision.current;inFlight.current=null;attempt.current=null;setDraft(null);setPending(null);setError(null);setCompleted(null);}
 useEffect(()=>{mounted.current=true;const off=bridge.onInvalidated(clear);return()=>{mounted.current=false;++revision.current;inFlight.current=null;attempt.current=null;off();};},[bridge]);
 useEffect(clear,[scopeKey,bridge]);
 async function submit(event:FormEvent){
  event.preventDefault();if(!enabled||!text.trim()||inFlight.current||!contactId||!sessionId)return;
  const operation={},boundary=revision.current;inFlight.current=operation;setPending(scopeKey);setError(null);setCompleted(null);
  const previous=attempt.current,requestKey=previous?.scopeKey===scopeKey&&previous.text===text?previous.requestKey:crypto.randomUUID();
  attempt.current={scopeKey,text,requestKey};
  const current=()=>mounted.current&&inFlight.current===operation&&revision.current===boundary&&latest.current.scopeKey===scopeKey&&latest.current.bridge===bridge;
  try{
   const result=await bridge.submit({contactId,scopeRevision,sessionId,requestKey,text});
   if(!current())return;if(result.requestKey!==requestKey)throw new Error('discussion_receipt_invalid');
   attempt.current=null;setDraft(null);setError(null);setCompleted({scopeKey,receipt:result});onSubmitted?.(result);
  }catch{if(current())setError({scopeKey,text:'讨论结果尚未确认。可保留原内容重试核对。'});}
  finally{if(current()){inFlight.current=null;setPending(null);}}
 }
 return <section aria-label="助手讨论输入" className="sqlite-discussion-composer">
  <h3>助手讨论</h3>
  <p>围绕当前联系人梳理想法。最终消息由你选择、修改并亲自发送。</p>
  <form onSubmit={event=>void submit(event)}>
   <label>讨论内容<textarea aria-label="讨论内容" value={text} maxLength={SQLITE_DISCUSSION_MAX_TEXT_LENGTH} disabled={!enabled||busy}
    placeholder="写下你想与助手讨论的事情" onChange={event=>{setDraft({scopeKey,text:event.target.value});setError(null);setCompleted(null);}} /></label>
   <button type="submit" disabled={!enabled||busy||!text.trim()}>{busy?'正在讨论…':failed?'重试与此联系人讨论':'与此联系人讨论'}</button>
  </form>
  {!enabled&&<p role="status">请先确认联系人并打开一段助手讨论。</p>}
  {failed&&<p role="alert">{error.text}</p>}
  {completed?.scopeKey===scopeKey&&<p role="status">{completed.receipt.segmented?'已开启新讨论，请查看已保存讨论中的结果。':completed.receipt.replayed?'已定位原请求，请查看已保存讨论中的结果。':'讨论请求已保存。'}</p>}
 </section>;
}
