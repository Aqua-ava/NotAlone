import { useCallback, useState } from 'react';
import type { ContactSessionView } from './contact-session';
import { SqliteSkillLibraryPage } from './SqliteSkillLibraryPage';
import type { BackendPhase } from '../shared/backend-bridge';
import { useConnectedSnapshot } from './use-connected-snapshot';
import './skill.css';

export function SkillLearningPage({ session, visible = true }: { session: ContactSessionView; visible?: boolean }) {
  // 管理窗口内保留已核对快照；隐藏时仍接收连接失效，不持久化到磁盘。
  return <div hidden={!visible}><SkillLearningContent session={session} visible={visible} /></div>;
}

function SkillLearningContent({ session, visible }: { session: ContactSessionView; visible: boolean }) {
  const [attempt,setAttempt]=useState(0);
  const bridge=window.notalone.skillLearning;
  const readLibrary=useCallback(()=>bridge.readLibrary(),[bridge]);
  const {state,invalidate}=useConnectedSnapshot(window.notalone.backend,readLibrary,attempt);
  if(state.phase==='ready')return <SqliteSkillLibraryPage key={state.value.connectionGeneration} initial={state.value} visible={visible} contacts={session.state.contacts ?? []} bridge={bridge} onUnavailable={invalidate}/>;
  const failure=state.phase==='failed'?'Skill 状态暂不可用，请重新读取。'
    :state.phase==='connection-read-failed'?'本机连接状态暂不可用，请重新读取 Skill 状态。':'';
  const connectionPhase=state.phase==='pending'?'connected':state.phase;
  const connectionMessage: Record<BackendPhase,string> = {
    connecting:'正在连接本机服务，连接后可查看 Skill。',
    connected:'正在核对 Skill 状态…',
    disconnected:'本机服务尚未连接，连接后可查看 Skill。',
    stopping:'正在停止本次后台读取，Skill 暂不可用。',
    stopped:'本次后台读取已停止。',
    'shutdown-failed':'后台停读尚未获确认，请重试停读或查看诊断。',
  };
  return <section aria-label="Skill管理"><h2>已有 Skill</h2>{failure?<><p role="alert">{failure}</p><button className="button" onClick={()=>setAttempt(value=>value+1)}>重新读取 Skill 状态</button></>:<p role={connectionPhase==='shutdown-failed'?'alert':'status'}>{connectionPhase in connectionMessage?connectionMessage[connectionPhase as BackendPhase]:'正在读取本机连接状态…'}</p>}</section>;
}
