import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionFinishFailure,sanitizeDiscussionFailure} from '../src/reply/sqlite/failure.ts';

test('SDK错误证据只保留固定分类，供应商正文编号与因果链不能落库',()=>{
 const unsafe={kind:'error',failure:{code:'SERVER',status:503,message:'合成正文及私密路径',requestId:'synthetic-private-id',cause:{message:'合成凭据'}}};
 assert.deepEqual(discussionFinishFailure(unsafe,'authorized_unconfirmed'),{kind:'error',code:'SERVER',status:503,dispatch:'authorized_unconfirmed'});
 assert.deepEqual(sanitizeDiscussionFailure({kind:'secret-kind',code:'SYNTHETIC_SECRET',status:999,dispatch:'secret-phase',message:'合成秘密'}),{kind:'other',code:'UNKNOWN',dispatch:'unknown'});
 assert.equal(discussionFinishFailure({kind:'stop'},'http_accepted'),undefined);
});
