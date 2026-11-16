/** 原库读取的制品协议；旧制品不得进入任何原库通道。 */
export const rawSourceSafetyProtocol = 'wechat-raw-source-readonly-v2';
export const rawSourceSafetyHistoryPatchSha256 = 'a0fc0989b3d65e5d0b094789df36e8753c3ac675bd1a93fa83534b24e71bf440';
export const rawSourceSafetyMarker = 'notalone-raw-source-safety:wechat-raw-source-readonly-v2';

/** 结合制品摘要复验实际字节，避免仅给旧 manifest 补字段就放行旧读取器。 */
export function hasRawSourceSafety(manifest: Record<string, unknown>, cli: Uint8Array): boolean {
  return manifest.rawSourceSafety === rawSourceSafetyProtocol
    && Buffer.from(cli.buffer, cli.byteOffset, cli.byteLength).includes(rawSourceSafetyMarker);
}
