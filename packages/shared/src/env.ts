import { z } from "zod";

/** Parses `process.env` (or a provided record) against a schema and fails with a readable error. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** A positive integer read from an environment variable, with a default. */
export function envInt(defaultValue: number): z.ZodDefault<z.ZodCoercedNumber> {
  return z.coerce.number().int().nonnegative().default(defaultValue);
}

/** A boolean read from an environment variable ("true"/"1"/"yes" are truthy). */
export function envBool(defaultValue: boolean): z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<boolean, string>> {
  return z
    .string()
    .default(defaultValue ? "true" : "false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()));
}

/** A comma separated list read from an environment variable. */
export function envList(
  defaultValue: string[],
): z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<string[], string>> {
  return z
    .string()
    .default(defaultValue.join(","))
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
}
