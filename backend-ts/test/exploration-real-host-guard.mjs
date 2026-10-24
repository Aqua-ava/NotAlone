/** 仅供真实启动夹具：官方 Messages 经过原 SDK，运输限定到自有本机 SSE。 */
import './main-host-reply-chain-preload.mjs';
import {appendFileSync} from 'node:fs';
process.on('uncaughtExceptionMonitor',error=>appendFileSync(process.env.NOTALONE_SYNTHETIC_HOST_ERRORS,String(error.stack)+'\n',{mode:0o600}));
