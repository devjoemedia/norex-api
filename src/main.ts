import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody is required for provider webhook signature verification (docs/09).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  // Security baseline (see docs/00 & docs/01).
  app.use(helmet());
  app.use(compression());
  app.set('trust proxy', 1);

  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : false,
    credentials: true,
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
