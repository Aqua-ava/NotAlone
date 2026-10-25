/** 只绑定根明确传入的既有问题总账；唯一 reserve 位于外层 broker。 */
import assert from 'node:assert/strict';
import {lstat,realpath} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {problemBudgetBridge} from '../ticket25-final-run/bridge.mjs';
import {freezeProblemBudgetConfiguration} from '../ticket25-final-run/execution-snapshot.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function bindExistingProblemBudget({configuration,expected}){
  const config=freezeProblemBudgetConfiguration(configuration,expected),path=config.budget.ledger;
  async function identity(){
    const [file,parent,actual]=await Promise.all([lstat(path),lstat(dirname(path)),realpath(path)]);
    assert.ok(file.isFile()&&!file.isSymbolicLink()&&(file.mode&0o777)===0o600
      &&parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700
      &&file.uid===process.getuid()&&parent.uid===file.uid,'root_budget_not_private');
    return [file.dev,file.ino,parent.dev,parent.ino,actual];
  }
  const pinned=await identity(),initial=await problemBudgetBridge(config,'ack'),known=new Map();
  let last=initial.used_reservations,busy=false,closed=false;
  async function current(action='ack'){
    assert.ok(!closed,'budget_port_closed');
    assert.deepEqual(await identity(),pinned,'root_budget_replaced');
    const receipt=await problemBudgetBridge(config,action);
    assert.equal(receipt.deadline,initial.deadline,'root_budget_deadline_changed');
    assert.equal(receipt.max_reservations,initial.max_reservations,'root_budget_limit_changed');
    assert.ok(receipt.used_reservations>=last,'root_budget_counter_decreased');
    return receipt;
  }
  return Object.freeze({persistent:true,reservationOwner:'outer_broker',problemId:config.budget.problem_id,
    deadline:initial.deadline*1000,maxReservations:initial.max_reservations,
    async inspect(){const r=await current();return {problemId:config.budget.problem_id,deadline:r.deadline*1000,
      maxReservations:r.max_reservations,used:r.used_reservations,remaining:r.max_reservations-r.used_reservations};},
    async reserve(binding){
      assert.ok(!busy,'root_budget_serial_dispatch_required');busy=true;
      try{
        const prior=await current(),r=await current('reserve');
        assert.equal(r.used_reservations,prior.used_reservations+1,'root_budget_reservation_race');
        last=r.used_reservations;
        const value=Object.freeze({reservation_id:randomUUID(),binding_sha256:sha(binding),ordinal:last,
          problemId:config.budget.problem_id,deadline:r.deadline*1000,reservation_owner:'outer_broker'});
        known.set(value.reservation_id,value);return value;
      }catch(error){closed=true;throw error;}finally{busy=false;}
    },
    async ack(reservation){
      assert.equal(known.get(reservation?.reservation_id),reservation,'root_reservation_unrecognized');
      const r=await current();assert.equal(r.used_reservations,reservation.ordinal,'root_reservation_ack_race');
      return reservation;
    },
  });
}
