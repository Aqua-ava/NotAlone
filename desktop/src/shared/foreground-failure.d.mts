export interface ForegroundFailureReason { code: string; layer: string; message: string }
export function foregroundFailureReason(code: string | null): ForegroundFailureReason | null;
