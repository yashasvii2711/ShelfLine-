export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'VALIDATION_ERROR') =>
  new AppError(400, code, message, details);
export const notFound = (what: string, id?: number | string) =>
  new AppError(404, 'NOT_FOUND', id === undefined ? `${what} not found` : `${what} ${id} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
