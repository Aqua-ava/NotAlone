/** 大小写不敏感的 8-4-4-4-12 十六进制标识格式，不校验版本位；无 g 标志，可安全共享。 */
export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid=(value:unknown):value is string=>typeof value==='string'&&uuidPattern.test(value);
