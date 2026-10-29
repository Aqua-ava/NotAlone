import {StorageFailure} from '../../storage/sqlite/contracts.ts';

export const voiceLimits = Object.freeze({inputBytes: 1_048_576, packets: 600, packetBytes: 1250, sampleRate: 24000, pcmBytes: 2_880_000, wallMs: 10_000});
const header = Buffer.from('\x02#!SILK_V3');
const invalid = (): never => {throw new StorageFailure('voice_container_invalid');};
export function inspectSilk(input: Uint8Array): {packets: number; termination: 'eof'|'sentinel'; maximumPcmBytes: number} {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (data.length > voiceLimits.inputBytes) throw new StorageFailure('voice_resource_limit');
  if (data.length < header.length || !data.subarray(0,10).equals(header)) return invalid();
  let offset = 10, packets = 0, termination: 'eof'|'sentinel' = 'eof';
  while (offset < data.length) {
    if (offset + 2 > data.length) return invalid();
    const size = data.readInt16LE(offset); offset += 2;
    if (size === -1) {if (offset !== data.length) return invalid(); termination = 'sentinel'; break;}
    if (size < 1 || size > voiceLimits.packetBytes || offset + size > data.length) return invalid();
    offset += size; packets++;
    if (packets > voiceLimits.packets) throw new StorageFailure('voice_resource_limit');
  }
  // 上游会无条件读取两个前置包，再读取下一包；少于三个不交给WASM。
  if (packets < 3) return invalid();
  return {packets, termination, maximumPcmBytes: packets * 5 * 480 * 2};
}
export function pcmToWav(input: Uint8Array): Buffer {
  if (!input.byteLength || input.byteLength % 2 || input.byteLength > voiceLimits.pcmBytes) throw new StorageFailure('voice_pcm_invalid');
  const wav = Buffer.alloc(44 + input.byteLength);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
  wav.write('data',36); wav.writeUInt32LE(input.byteLength,40); wav.set(input,44);
  inspectWav(wav); return wav;
}
export function inspectWav(input: Uint8Array): {sampleRate:24000; channels:1; bitsPerSample:16; pcmBytes:number; durationMs:number} {
  const b = Buffer.from(input.buffer,input.byteOffset,input.byteLength);
  if (b.length < 46 || b.length > voiceLimits.pcmBytes + 44 || b.toString('ascii',0,4)!=='RIFF' || b.readUInt32LE(4)!==b.length-8 ||
      b.toString('ascii',8,16)!=='WAVEfmt ' || b.readUInt32LE(16)!==16 || b.readUInt16LE(20)!==1 || b.readUInt16LE(22)!==1 ||
      b.readUInt32LE(24)!==24000 || b.readUInt32LE(28)!==48000 || b.readUInt16LE(32)!==2 || b.readUInt16LE(34)!==16 ||
      b.toString('ascii',36,40)!=='data' || b.readUInt32LE(40)!==b.length-44 || (b.length-44)%2) return invalid();
  return {sampleRate:24000, channels:1, bitsPerSample:16, pcmBytes:b.length-44, durationMs:(b.length-44)/48};
}
