import {createInterface} from 'node:readline';
import {bindDiagnosticProblemBudget,DiagnosticProblemBudgetError} from '../src/diagnostic-problem-budget.ts';

const guard=bindDiagnosticProblemBudget({NOTALONE_PROBLEM_BUDGET:process.argv[2],NOTALONE_PROBLEM_ROUND:process.argv[3]});
const input=createInterface({input:process.stdin})[Symbol.asyncIterator]();
process.stdout.write('ready\n');await input.next();
let reserved=0;
for(let i=0;i<16;i++) {
 try{guard.reserve()();reserved++;}
 catch(error){if(!(error instanceof DiagnosticProblemBudgetError))throw error;break;}
}
process.stdout.write(JSON.stringify({reserved})+'\n');process.exit(0);
