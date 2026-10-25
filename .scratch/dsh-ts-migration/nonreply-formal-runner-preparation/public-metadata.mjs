/** 公开摘要只保留计数、状态、绑定与哈希；正文留私有journal。 */
import {sha} from '../resumed-nonreply-evaluation/runner.mjs';
export function publicObservation(row){
  const {audit,adaptation,event_receipts,output,business_output,...rest}=row;
  return {...rest,output,business_output,
    audit:audit?Object.fromEntries(Object.entries(audit).filter(([key])=>!['trace_events','request_bodies','response_bodies','final_state'].includes(key))):null,
    adaptation_sha256:adaptation?sha(adaptation):null,events:event_receipts??[],
    trace_events_sha256:audit?.trace_events?sha(audit.trace_events):null,
    requests_sha256:audit?.request_bodies?sha(audit.request_bodies):null,
    responses_sha256:audit?.response_bodies?sha(audit.response_bodies):null,
    final_state_sha256:audit?.final_state?sha(audit.final_state):null};
}
