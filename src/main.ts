import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import compression from 'compression';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { isAllowedOrigin, parseOrigins } from './common/http/cors';

async function bootstrap() {
  // rawBody is required for provider webhook signature verification (docs/09).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  // Website applications carry compressed photos; registered before Nest's default
  // 100kb parser so only this route accepts large bodies (docs/16).
  app.use('/api/web', json({ limit: '12mb' }));
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  // Security baseline (see docs/00 & docs/01).
  app.use(helmet());
  app.use(compression());
  // Hops of reverse proxy in front of the API (Render = 1), so req.ip is the client.
  app.set('trust proxy', config.get<number>('TRUST_PROXY_HOPS', 1));

  // Only browsers need CORS (the admin portal). The website calls server-to-server.
  const origins = parseOrigins(config.get<string>('CORS_ORIGINS'));
  if (!origins.length && config.get<string>('NODE_ENV') === 'production') {
    app.get(Logger).warn('CORS_ORIGINS is empty: browsers (the admin portal) are blocked');
  }
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin, origins)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600, // cache preflights for 10 minutes
    exposedHeaders: ['Content-Disposition', 'Retry-After', 'X-Request-Id'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant',
      'X-Actor-Role',
      'X-Actor-Id',
      'Idempotency-Key',
      'X-Request-Id',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
  app.get(Logger).log(`Norex API listening on :${port}`);
}

void bootstrap();
