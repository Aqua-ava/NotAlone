import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createL2ScenarioHttp} from '../src/memory/scenarios/http.ts';
import {L3ProfileServiceConflict} from '../src/memory/profiles/service.ts';

test('L2/L3公开HTTP把画像纠错和撤回交给画像入口并映射失效版本', async t => {
  const owner = randomUUID(), contact = randomUUID(), token = 'h'.repeat(48);
  let profileCommand, withdrawCommand, paragraphCalls = 0, rejectNext = false;
  const state = {scope_kind:'contact', contact_id:contact, profile:null, scenarios:[]};
  const service = {
    async run(){throw new Error('unused');},
    async read(){return state;},
    async reportParagraphError(){paragraphCalls++;throw new Error('wrong_handler');},
    async reportProfileError(scope, command){
      if (rejectNext) throw new L3ProfileServiceConflict('l3_profile_feedback_target_stale');
      profileCommand = {scope, command};
      return state;
    },
    async withdrawScenario(){throw new Error('unused');},
    async withdrawProfile(scope, settingsGeneration, organizationGeneration, profileVersionId){
      withdrawCommand = {scope,settingsGeneration,organizationGeneration,profileVersionId};
      return state;
    },
  };
  const http = createL2ScenarioHttp({ownerId:owner, token, service});
  const server = createServer(async (request, response) => {
    const result = await http.handlePublic(request, response, new URL(request.url, 'http://127.0.0.1'));
    if (!result.handled && !response.writableEnded) {
      response.writeHead(404, {'Content-Type':'application/json'});
      response.end('{"error":"not_found"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${address.port}/api/contacts/${contact}/layered-memory/summary-error`;
  const command = {
    settings_generation:3,
    organization_generation:9,
    target_kind:'profile',
    version_id:randomUUID(),
    item_index:1,
    reason:'合成画像概括过强。',
    operation_id:randomUUID(),
  };
  const request = body => fetch(url, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body),
  });

  const accepted = await request(command);
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).layered_memory, state);
  assert.equal(paragraphCalls, 0);
  assert.deepEqual(profileCommand, {
    scope:{owner_id:owner, contact_id:contact},
    command:{
      settings_generation:3,
      organization_generation:9,
      version_id:command.version_id,
      item_index:1,
      operation_id:command.operation_id,
      reason:command.reason,
    },
  });

  rejectNext = true;
  const stale = await request({...command, operation_id:randomUUID()});
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {error:'l3_profile_feedback_target_stale'});

  const withdrawUrl = `http://127.0.0.1:${address.port}/api/contacts/${contact}/layered-memory/withdraw-profile`;
  const profileVersionId = randomUUID();
  const withdrawn = await fetch(withdrawUrl, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      settings_generation:3,
      organization_generation:9,
      profile_version_id:profileVersionId,
    }),
  });
  assert.equal(withdrawn.status, 200);
  assert.deepEqual((await withdrawn.json()).layered_memory, state);
  assert.deepEqual(withdrawCommand, {
    scope:{owner_id:owner, contact_id:contact},
    settingsGeneration:3,
    organizationGeneration:9,
    profileVersionId,
  });
});
