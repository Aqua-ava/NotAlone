import {sha256} from './sha256.ts';

/** 递归按键码点序重排对象键后的 JSON 文本；数组顺序保留，仅非数组对象参与键排序。键值形状由调用点负责，本文件不改写输入结构。 */
export const sortedKeyJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);

/** 稳定序列化后取 SHA-256 的统一入口；各删除域身份哈希与 media/reply 的比较序列化共用，输出必须与被替换的域内实现逐字节相同。 */
export const sha256StableJson = (value: unknown): string => sha256(sortedKeyJson(value));

/** 列名键对象 → 键码点序键值对数组。各删除调用点的键集合是所在域 rowKinds 的固定
 *  ASCII 列名（snake_case，全部 US-ASCII），localeCompare/成对默认序在该集合上与码点序同序，
 *  由 test/deletion-identity-profile.test.mjs 的固定用例逐字节核验；键码点序同时不再随运行环境 ICU 语义变化。 */
export const sortedEntries = (key: Record<string, string>): [string, string][] => Object.keys(key).sort().map(k => [k, key[k]]);
