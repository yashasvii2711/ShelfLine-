import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { query } from './db/pool';
import { openapiSpec } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';
import { createRateLimiter } from './middleware/rateLimit';
import { authRouter } from './routes/auth';
import { router } from './routes';
import { logger, requestContext } from './utils/logger';

export interface AppOptions {
  rateLimit?: { windowMs: number; max: number };
  authRateLimit?: { windowMs: number; max: number };
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Swagger UI needs inline scripts, so relax CSP only for the docs route
  app.use('/api-docs', helmet({ contentSecurityPolicy: false }));
  app.use(helmet());

  // Request id on every request (honours an incoming X-Request-Id) + structured access log
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use((req, _res, next) => requestContext.run({ requestId: String(req.id) }, next));

  app.use(express.json({ limit: '100kb' }));

  // Web UI (static files in /public). Works from both src/ (ts-node) and dist/ (compiled).
  app.use(express.static(path.resolve(__dirname, '../public')));

  app.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    }
  });

  app.get('/api-docs.json', (_req, res) => res.json(openapiSpec));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.use('/api', createRateLimiter(options.rateLimit ?? config.rateLimit));
  // Sign-up / sign-in get a much stricter limit to slow down password guessing
  app.use('/api/auth', createRateLimiter(options.authRateLimit ?? config.authRateLimit), authRouter);
  app.use('/api', authenticate, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// Default export: lets serverless hosts such as Vercel pick the app up without a listener
export default createApp();
