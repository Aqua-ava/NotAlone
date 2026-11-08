import {record,report,target,buildCandidate} from '../../sqlite-clear-support.mjs';

export const gate=()=>Promise.withResolvers();
export const normalCapabilities={...report.capabilities,...Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail','durableIncremental','durableHistory','partitionGrowth','recoverFromLocalIds'].map(key=>[key,'supported']))};
/** 仅替代原生渠道；恢复位置由正式存储入口计算，恢复游标由渠道签发，不由测试拼装。 */
export function recoveryReader(options={}){
 const state={pageRecords:options.records??[record('shard-a','1')],pageCalls:0,inspectCalls:0,readIds:[],positions:[],recovered:0,channels:[],entries:[],reportOverride:{},targetOverride:{},boundaryMembers:[],boundaryOptions:{},inspectFactory:null,pageHook:null,pageFactory:null,recoverHook:null,channelHook:null,closeHook:null};
 const create=()=>{
  const loss=gate(),entry={index:state.channels.length,positions:null,reading:false,channel:null,loss,code:null};
  const fixed={...structuredClone(target),checkedPartitions:[...target.partitions],descriptor:`synthetic-snapshot-${state.channels.length+1}`};
  const channel={guardSession:{loss:loss.promise,failureCode:()=>entry.code},
   async inspect(scope){state.inspectCalls++;if(state.inspectFactory)return state.inspectFactory(scope,state);return {...report,capabilities:normalCapabilities,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,...state.reportOverride};},
   async target(){return {...structuredClone(fixed),...state.targetOverride};},
   async recoverTarget(scope,previous,positions,signal){entry.positions=structuredClone(positions);state.positions=structuredClone(positions);state.recovered++;const result={target:{...structuredClone(fixed),...state.targetOverride},cursor:'reader-signed-recovery',anchors:state.pageRecords.filter(r=>positions.some(p=>p.partition===r.partition&&p.table===r.table&&p.anchorLocalIds.includes(r.localId)))};return await state.recoverHook?.({scope,previous,positions,signal,entry,result})??result;},
   async page(scope,used,cursor,signal){entry.reading=true;state.pageCalls++;await state.pageHook?.({scope,used,cursor,signal,entry});const records=state.pageRecords.filter(r=>!entry.positions||entry.positions.every(p=>p.partition!==r.partition||p.table!==r.table||BigInt(r.localId)>BigInt(p.maxLocalId)));const result=state.pageFactory?await state.pageFactory({scope,used,cursor,records,signal,entry}):{target:used.descriptor,cursorIn:cursor,cursorOut:null,records,completedPartitions:[...used.partitions],exhausted:true,...(state.reportOverride.capabilities?.incrementalTail==='unsupported'?{}:{resumeCursor:'reader-signed-tail'})};state.readIds.push(...result.records.map(r=>r.localId));return result;},
   async tail(_scope,used,cursor){return {target:used.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true};},
   async boundarySnapshot(scope){return buildCandidate(scope,state.boundaryMembers,state.boundaryOptions);},
   async close(){await state.closeHook?.(entry);loss.resolve();},
  };
  entry.channel=channel;state.channels.push(channel);state.entries.push(entry);state.channelHook?.(channel,entry);return channel;
 };return {state,create};
}
