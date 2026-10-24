import assert from 'node:assert/strict';
import test from 'node:test';
import {pageRoleAllowed} from '../src/main/page-commands.ts';

test('页面角色范围支持单角色与只读多角色，但不放行未知窗口', () => {
  assert.equal(pageRoleAllowed('manager','manager'),true);
  assert.equal(pageRoleAllowed('helper','manager'),false);
  assert.equal(pageRoleAllowed('helper',['manager','helper']),true);
  assert.equal(pageRoleAllowed(undefined,['manager','helper']),false);
  assert.equal(pageRoleAllowed('helper',undefined),true);
});
