export interface ForegroundFailureReason { code: string; layer: string; message: string }
export function foregroundFailureReason(code: string | null): ForegroundFailureReason | null;
export function isTransientForegroundContextChange(code: string | null): boolean;
export function isUnsupportedForegroundConversation(code: string | null): boolean;
