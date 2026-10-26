import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, buildQueryTokens, score } from '../src/retrieval/retrieval-lexical.ts';
test('NFKC、casefold、非BMP及首尾接缝保持旧词法合同', () => {
 assert.deepEqual(tokenize('ＴＥＡ Straße 𠀀茶').map(t=>t.text), ['tea','strasse','𠀀','茶','𠀀茶']);
 const query='甲'.repeat(100)+'丙'.repeat(30)+'乙'.repeat(100);
 assert.equal(buildQueryTokens(query).some(t=>t.text==='甲乙'), false);
 assert.deepEqual(score('茶 tea','ＴＥＡ'), {score:2/3,matched_terms:['tea']});
});
