import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionFinishFailure,sanitizeDiscussionFailure,sanitizeDiscussionErrorCode} from '../src/reply/sqlite/failure.ts';

test('SDK错误证据只保留固定分类，供应商正文编号与因果链不能落库',()=>{
 const unsafe={kind:'error',failure:{code:'SERVER',status:503,message:'合成正文及私密路径',requestId:'synthetic-private-id',cause:{message:'合成凭据'}}};
 assert.deepEqual(discussionFinishFailure(unsafe,'authorized_unconfirmed'),{kind:'error',code:'SERVER',status:503,dispatch:'authorized_unconfirmed'});
 assert.deepEqual(sanitizeDiscussionFailure({kind:'secret-kind',code:'SYNTHETIC_SECRET',status:999,dispatch:'secret-phase',message:'合成秘密'}),{kind:'other',code:'UNKNOWN',dispatch:'unknown'});
 assert.equal(discussionFinishFailure({kind:'stop'},'http_accepted'),undefined);
});

test('准备超时、存储中断和运行时中断保留固定原因，任意异常正文仍被拒绝',()=>{
 for(const code of ['discussion_preparation_timeout','discussion_storage_interrupted','runtime_interrupted'])assert.equal(sanitizeDiscussionErrorCode(code),code);
 assert.equal(sanitizeDiscussionErrorCode('worker_failed'),'discussion_generation_failed');
 assert.equal(sanitizeDiscussionErrorCode('合成供应商异常正文'),'discussion_generation_failed');
});
