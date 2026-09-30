import { Type } from "typebox";
import Value from "typebox/value";

export class ValidationError extends Error {
  readonly issues: string[];

  constructor(kind: string, issues: string[]) {
    super(`${kind}: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function rejectUnknown(schema: Type.TSchema, value: unknown, kind: string): void {
  const issues = Value.Errors(schema, value).map((error) => {
    const at = error.instancePath === "" ? "" : ` at ${error.instancePath}`;
    return `${error.message}${at}`;
  });
  if (issues.length > 0) throw new ValidationError(kind, issues);
}
