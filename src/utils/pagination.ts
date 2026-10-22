import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

export interface Page<T> {
  data: T[];
  pagination: { page: number; size: number; totalItems: number; totalPages: number };
}

export function buildPage<T>(data: T[], page: number, size: number, totalItems: number): Page<T> {
  return { data, pagination: { page, size, totalItems, totalPages: Math.ceil(totalItems / size) } };
}
