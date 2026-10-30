import {readSqliteCandidateOperation} from '../shared/sqlite-reply-candidates';
import {readSqliteDiscussionSubmit,type SqliteDiscussionBridge,type SqliteDiscussionInvalidation} from '../shared/sqlite-discussion-bridge';
import type {PageTransport} from './transport';
export function createSqliteDiscussionBridge(transport:PageTransport):SqliteDiscussionBridge {
 return Object.freeze({
  candidates:Object.freeze({execute:(...args:unknown[])=>{try{if(args.length!==1)throw new Error('本次候选操作无效。');return transport.invoke('sqlite-reply-candidates:execute',readSqliteCandidateOperation(args[0]));}catch(error){return Promise.reject(error);}}}),
  submit:(...args:unknown[])=>{try{if(args.length!==1)throw new Error('本次讨论操作无效。');return transport.invoke('sqlite-discussion:submit',readSqliteDiscussionSubmit(args[0]));}catch(error){return Promise.reject(error);}},
  onInvalidated:(listener:(event:SqliteDiscussionInvalidation)=>void)=>{
   if(typeof listener!=='function')throw new Error('本次讨论操作无效。');const receive=(_event:unknown,state:SqliteDiscussionInvalidation)=>listener(state);
   transport.on('sqlite-discussion:invalidated',receive);return()=>transport.removeListener('sqlite-discussion:invalidated',receive);
  },
 });
}
