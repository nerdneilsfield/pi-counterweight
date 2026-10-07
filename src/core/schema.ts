/**
 * TypeBox 运行时校验封装：把校验失败统一成带 `kind` 前缀的 `ValidationError`。
 *
 * The project's TypeBox validation wrapper: validation failures become a single
 * `ValidationError` labelled with the caller's `kind`. Callers author schemas
 * with `additionalProperties: false`, so unknown keys are rejected, not ignored.
 */
import { Type } from "typebox";
import Value from "typebox/value";

/**
 * 运行时校验失败：`issues` 是逐条错误描述（含实例路径），`message` 把它们拼成一行 `kind: ...`。
 *
 * A runtime validation failure: `issues` holds one description per error (with
 * its instance path) and `message` joins them into one `kind: ...` line, ready
 * for logs or for wrapping by the caller.
 */
export class ValidationError extends Error {
  readonly issues: string[];

  /**
   * @param kind - 出错文档名，作为消息前缀 / Document name, used as the message prefix.
   * @param issues - 逐条错误描述 / One description per validation error.
   */
  constructor(kind: string, issues: string[]) {
    super(`${kind}: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/**
 * 校验 `value` 是否符合 `schema`，有任何错误（含未知字段）就抛 `ValidationError`；错误列表来自 `Value.Errors`，逐条附带实例路径。
 *
 * Validates `value` against `schema` and throws `ValidationError` when any error
 * exists — unknown properties included, since project schemas forbid them. The
 * error list comes from `Value.Errors`, each entry carrying its instance path.
 * Callers rely on the throw to fail closed before casting the value to its
 * declared type.
 *
 * @param schema - TypeBox 校验模式 / TypeBox schema to validate against.
 * @param value - 已解析但尚未信任的值 / The parsed value, not yet trusted.
 * @param kind - 出错文档名，作为错误前缀 / Document name, used as the error prefix.
 * @returns 通过时静默返回 `void` / Returns `void` on success.
 * @throws {ValidationError} 存在任何校验错误时 / When any validation error exists.
 */
export function rejectUnknown(schema: Type.TSchema, value: unknown, kind: string): void {
  const issues = Value.Errors(schema, value).map((error) => {
    const at = error.instancePath === "" ? "" : ` at ${error.instancePath}`;
    return `${error.message}${at}`;
  });
  if (issues.length > 0) throw new ValidationError(kind, issues);
}
