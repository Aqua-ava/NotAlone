/** 判断值是否为普通对象（非 null、非数组），供各处读取外部 JSON 时共用。 */
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
