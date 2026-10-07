/**
 * 规范化序列化 + SHA-256：对象键递归排序、丢掉 `undefined` 属性，得到与字段书写顺序无关的稳定哈希。
 *
 * Canonical serialization plus SHA-256: object keys are sorted recursively and
 * `undefined` properties are dropped, so structurally equal values hash the
 * same regardless of key order. Arrays keep their order, and an explicit `null`
 * is not the same as a missing key.
 */
import { createHash } from "node:crypto";

/**
 * 返回 `value` 规范化 JSON 的 SHA-256 十六进制摘要；同一份契约或配置重新序列化后哈希不变。
 *
 * Returns the SHA-256 hex digest of `value`'s canonical JSON. Re-serializing the
 * same contract or config yields the same identity, which is what approval and
 * drift checks compare.
 *
 * @param value - 要哈希的值，必须可 JSON 序列化 / The value to hash; it must be JSON-serializable.
 * @returns 64 个小写十六进制字符 / A 64-character lowercase hex digest.
 */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

/**
 * 规范化用的递归复制：对象按键升序重排并移除 `undefined` 属性，数组保持原序，其余值原样返回；不改动输入。
 *
 * Recursive copy for canonicalization: objects are re-emitted with keys in
 * ascending order and `undefined` properties removed, arrays keep their order,
 * and every other value is returned unchanged. Never mutates its input.
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
