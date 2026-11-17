import { useEffect, useState } from 'react';
import type { ContactSessionView } from './contact-session';
import { SqliteSkillLibraryPage } from './SqliteSkillLibraryPage';
import type { SkillLibrarySnapshot } from '../shared/skill-library-bridge';
import type { BackendPhase } from '../shared/backend-bridge';
import './skill.css';

export function SkillLearningPage({ session, visible = true }: { session: ContactSessionView; visible?: boolean }) {
  // 管理窗口内保留已核对快照；隐藏时仍接收连接失效，不持久化到磁盘。
  return <div hidden={!visible}><SkillLearningContent session={session} visible={visible} /></div>;
}

function SkillLearningContent({ session, visible }: { session: ContactSessionView; visible: boolean }) {
  const [library,setLibrary]=useState<SkillLibrarySnapshot|null>(null),[failure,setFailure]=useState(''),[attempt,setAttempt]=useState(0);
  const [connectionPhase,setConnectionPhase]=useState<BackendPhase|null>(null);
  const bridge=window.notalone.skillLearning;
  useEffect(()=>{
    let active=true,request=0,connected=false,revision=-1,connectionObserved=false;
    setConnectionPhase(null);setFailure('');
    const read=()=>{const current=++request;setLibrary(null);setFailure('');void bridge.readLibrary().then(value=>{if(active&&current===request)setLibrary(value);},()=>{if(active&&current===request)setFailure('Skill 状态暂不可用，请重新读取。');});};
    const receive=(state: {phase: BackendPhase; revision?: number})=>{
      if(!active || state.revision !== undefined && state.revision < revision)return;
      if(state.revision !== undefined)revision=state.revision;
      connectionObserved=true;setConnectionPhase(state.phase);
      if(state.phase==='connected'){if(!connected)read();connected=true;}
      else{connected=false;++request;setLibrary(null);setFailure('');}
    };
    const backend=window.notalone.backend;
    const unsubscribe=backend?.onStateChanged(receive);
    if(backend?.getState)void backend.getState().then(receive,()=>{if(active&&!connectionObserved)setFailure('本机连接状态暂不可用，请重新读取 Skill 状态。');});
    else{connected=true;setConnectionPhase('connected');read();}
    return()=>{active=false;unsubscribe?.();};
  },[bridge,attempt]);
  if(library)return <SqliteSkillLibraryPage key={library.connectionGeneration} initial={library} visible={visible} contacts={session.state.contacts ?? []} bridge={bridge} onUnavailable={()=>{setLibrary(null);setFailure('Skill 状态暂不可用，请重新读取。');}}/>;
  const connectionMessage: Record<BackendPhase,string> = {
    connecting:'正在连接本机服务，连接后可查看 Skill。',
    connected:'正在核对 Skill 状态…',
    disconnected:'本机服务尚未连接，连接后可查看 Skill。',
    stopping:'正在停止本次后台读取，Skill 暂不可用。',
    stopped:'本次后台读取已停止。',
    'shutdown-failed':'后台停读尚未获确认，请重试停读或查看诊断。',
  };
  return <section aria-label="Skill管理"><h2>已有 Skill</h2>{failure?<><p role="alert">{failure}</p><button className="button" onClick={()=>setAttempt(value=>value+1)}>重新读取 Skill 状态</button></>:<p role={connectionPhase==='shutdown-failed'?'alert':'status'}>{connectionPhase?connectionMessage[connectionPhase]:'正在读取本机连接状态…'}</p>}</section>;
}
