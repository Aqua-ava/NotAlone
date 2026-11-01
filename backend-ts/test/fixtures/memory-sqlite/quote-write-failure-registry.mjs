import {registry as base} from '../../../src/storage/sqlite/registry.ts';

const rejectQuoteWrite={name:'test.installQuoteWriteFailure',mode:'write',retryBusy:false,execute(tx){
 tx.run("CREATE TRIGGER test_reject_quote_write BEFORE INSERT ON history_quote BEGIN SELECT RAISE(ABORT,'synthetic_quote_write_failure'); END");
 return true;
}};

export const registry={...base,actions:[...base.actions,rejectQuoteWrite]};
