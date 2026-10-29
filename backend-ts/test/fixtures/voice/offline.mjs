import net from 'node:net';
import tls from 'node:tls';
// 验证WASM资产离线加载；此夹具不替换编解码器、文件或数据库。
const deny=()=>{throw Error('offline-test-network-forbidden');};
net.Socket.prototype.connect=deny;tls.connect=deny;globalThis.fetch=deny;
