import test from 'node:test';
import {runRetryRegression} from './retry-regression.mjs';
test('官方profile/PG/ModelHost故障E一次V零次且保留账本',{timeout:45000},async()=>{await runRetryRegression();});
