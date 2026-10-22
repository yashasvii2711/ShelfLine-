import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'inventory-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Carries the request id through async calls so service-level logs can be correlated. */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function getLogger(): pino.Logger {
  const ctx = requestContext.getStore();
  return ctx ? logger.child({ requestId: ctx.requestId }) : logger;
}
