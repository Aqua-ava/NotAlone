import {useEffect,useRef,useState} from 'react';
import type {SkillLibraryBridge,SkillLibraryItem,SkillLibrarySnapshot,SqliteSkillLibrarySnapshot} from '../shared/skill-library-bridge';
const enabledLabels={enabled:'已启用',disabled:'已停用',unknown:'待核验启停'};
const verificationLabels={verified:'目录已核验',pending:'待核验',missing:'目录或文件缺失',conflict:'目录身份冲突',invalid:'文件校验失败'};
export function SqliteSkillLibraryPage({initial,bridge,onModeChange,onUnavailable}:{initial:SqliteSkillLibrarySnapshot;bridge:SkillLibraryBridge;onModeChange:(value:SkillLibrarySnapshot)=>void;onUnavailable:()=>void}) {
 const [view,setView]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false);
 const active=useRef(true);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 async function perform(operation:()=>Promise<SkillLibrarySnapshot>){
  if(busy)return;setBusy(true);setError('');
  try {const next=await operation();if(!active.current)return;if(next.mode!=='sqlite'){onModeChange(next);return;}setView(next);setStale(false);}
  catch(reason){if(!active.current)return;setStale(true);setError(reason instanceof Error?reason.message:'Skill 状态暂不可用，请刷新后再操作。');onUnavailable();}
  finally{if(active.current)setBusy(false);}
 }
 const command=(item:SkillLibraryItem)=>({packageId:item.packageId,expectedHeadRevision:item.headRevision,connectionGeneration:view.connectionGeneration,confirmed:true as const});
 return <section aria-label="Skill管理">
  <h2>已有 Skill</h2>
  <p>已启用的 Skill 会自动检查文件更新，并在回复时按需加载。</p>
  <button className="button" disabled={busy} onClick={()=>void perform(()=>bridge.readLibrary())}>{busy?'正在核对…':'刷新 Skill 状态'}</button>
  {error&&<p role="alert">{error}</p>}
  {!view.skills.length&&<p role="status">暂无 Skill。</p>}
  {view.skills.map(item=><article className="memory-card" key={item.packageId} aria-label={`Skill ${item.name}`}>
   <h3>{item.name}</h3><p>{item.description}</p>
   <p role="status">{enabledLabels[item.enabledState]} · {verificationLabels[item.verificationState]}</p>
   {item.verificationReason==='source_qualification_changed'&&<p>来源资格待核验，不能仅凭相同文件恢复使用。</p>}
   <div className="button-row">
    {item.enabledState!=='enabled'&&<button className="button" disabled={busy||stale} onClick={()=>void perform(()=>bridge.changeLibraryEnabled({...command(item),enabled:true}))}>确认启用</button>}
    {item.enabledState!=='disabled'&&<button className="button" disabled={busy||stale} onClick={()=>void perform(()=>bridge.changeLibraryEnabled({...command(item),enabled:false}))}>{item.enabledState==='unknown'?'确认停用':'停用'}</button>}
   </div>
  </article>)}
 </section>;
}
