import type { PageTransport } from './transport';
import type { MemoryUpgradeBridge, MemoryUpgradeState } from '../shared/memory-upgrade-bridge';
export function createMemoryUpgradeBridge(transport:PageTransport):MemoryUpgradeBridge{
  return Object.freeze({
    getState:(...args:unknown[])=>args.length?Promise.reject(new Error('升级操作无效。')):transport.invoke('memory-upgrade:get-state'),
    selectScope:(...args:unknown[])=>transport.invoke('memory-upgrade:select-scope',...args),
    refresh:(...args:unknown[])=>transport.invoke('memory-upgrade:refresh',...args),
    prepare:(...args:unknown[])=>transport.invoke('memory-upgrade:prepare',...args),
    operate:(...args:unknown[])=>transport.invoke('memory-upgrade:operate',...args),
    onStateChanged:(listener:(state:MemoryUpgradeState)=>void)=>{
      if(typeof listener!=='function')throw new Error('升级操作无效。');
      const receive=(_event:unknown,state:MemoryUpgradeState)=>listener(state);
      transport.on('memory-upgrade:state-changed',receive);return ()=>transport.removeListener('memory-upgrade:state-changed',receive);
    },
  });
}
