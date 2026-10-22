import { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

/** Parses `data` with a zod schema, throwing a 400 AppError with per-field details. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
    throw badRequest('Validation failed', details);
  }
  return result.data;
}

/** Validates a numeric path id. */
export function idParam(value: string | undefined, name = 'id'): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return Number(value);
}

export const optionalBool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const money = z
  .number({ invalid_type_error: 'must be a number' })
  .min(0)
  .max(9_999_999_999.99)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'must have at most 2 decimal places');

export const searchText = z.string().trim().max(100).optional();

/** Escapes LIKE wildcards so user search text is matched literally. */
export const likePattern = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
