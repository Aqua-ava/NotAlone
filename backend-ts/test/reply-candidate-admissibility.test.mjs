import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateReplyCandidates} from '../src/reply/generation/reply-contract.ts';
import {replyCandidateAdmissibility,replyCandidateLimit} from '../src/reply/generation/reply-candidate-admissibility.ts';

const evidence=randomUUID();
const candidate=(text)=>({text,basis:'本次合成意图',citation_ids:[evidence],risk_notes:[]});
const context=(user_instruction,risk_notes=[])=>({
  command:{content:{type:'rewrite_draft',draft_text:'轻松问候',user_instruction}},
  risk_notes,
});

test('明确未知存在时只准入一条候选，不让额外风格变体编码未知',()=>{
  const value=context(JSON.stringify({allowed_changes:['措辞'],unknowns:['联系间隔']}));
  const limit=replyCandidateLimit(value);
  assert.equal(limit,1);
  assert.deepEqual(replyCandidateAdmissibility(value),{limit:1,unknowns:['联系间隔']});
  assert.doesNotThrow(()=>validateReplyCandidates({candidates:[candidate('嗨，最近怎么样？')]},new Set([evidence]),limit));
  assert.throws(
    ()=>validateReplyCandidates({candidates:[candidate('嗨，最近怎么样？'),candidate('嗨，好久没聊了')]},new Set([evidence]),limit),
    {code:'reply_candidates_rejected'},
  );
});

test('未知候选配额按结构生效，不依赖任何假事实句式或黑名单',()=>{
  const limit=replyCandidateLimit(context(JSON.stringify({unknowns:['任意状态']})));
  for(const text of ['嗨，好久没聊了','突然想起你','这次没办法参加','我还在看时间']){
    assert.throws(
      ()=>validateReplyCandidates({candidates:[candidate('嗨，最近怎么样？'),candidate(text)]},new Set([evidence]),limit),
      {code:'reply_candidates_rejected'},
    );
  }
});

test('上下文风险也触发单候选；没有未知时保留最多三条产品能力',()=>{
  assert.equal(replyCandidateLimit(context('只做基础润色',['请核实承诺相关内容。'])),1);
  const limit=replyCandidateLimit(context('只做基础润色'));
  assert.equal(limit,3);
  assert.doesNotThrow(()=>validateReplyCandidates({
    candidates:[candidate('嗨'),candidate('你好'),candidate('最近怎么样？')],
  },new Set([evidence]),limit));
});

test('非结构化用户要求不冒充已解析的未知清单',()=>{
  assert.deepEqual(replyCandidateAdmissibility(context('请写得自然一点')),{limit:3,unknowns:[]});
  assert.deepEqual(replyCandidateAdmissibility(context(JSON.stringify({unknowns:['']}))),{limit:3,unknowns:[]});
});
