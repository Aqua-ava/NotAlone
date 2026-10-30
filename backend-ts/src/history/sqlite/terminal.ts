import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import {randomUUID} from 'node:crypto';
export type SourceTerminalReason='source_recalled'|'source_system_replaced';

/** 这是无正文终态，不是一次实际捕获；来源键和最初接受代次不回写、不复用删除操作。 */
export function rememberSourceTerminal(tx:StorageTransaction,token:ReadEligibility,key:string,reason:SourceTerminalReason):void{
 tx.run(`INSERT INTO history_source_terminal VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,contact_id,binding_id,external_key)
  DO NOTHING`,
  [token.owner_id,randomUUID(),token.contact_id,token.binding_id,key,reason,BigInt(token.data_generation)]);
}
