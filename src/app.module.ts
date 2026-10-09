import { ClassSerializerInterceptor, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { validateEnv } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { TenancyModule } from './common/tenancy/tenancy.module';
import { AuditModule } from './common/audit/audit.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { StorageModule } from './common/storage/storage.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { KycModule } from './modules/kyc/kyc.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { FinancingModule } from './modules/financing/financing.module';
import { LeaseModule } from './modules/lease/lease.module';
import { TradeInModule } from './modules/trade-in/trade-in.module';
import { ContentModule } from './modules/content/content.module';
import { BranchesModule } from './modules/branches/branches.module';
import { FulfilmentModule } from './modules/fulfilment/fulfilment.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { AdminModule } from './modules/admin/admin.module';
import { CountriesModule } from './modules/countries/countries.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { AllTenantsGuard } from './common/guards/all-tenants.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            '*.password',
            '*.phone',
            '*.idNumber',
            '*.token',
          ],
          censor: '[redacted]',
        },
        transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('THROTTLE_TTL', 60) * 1000,
          limit: config.get<number>('THROTTLE_LIMIT', 120),
        },
      ],
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<number>('JWT_ACCESS_TTL', 900) },
      }),
    }),
    DatabaseModule,
    TenancyModule,
    AuditModule,
    IdempotencyModule,
    StorageModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    KycModule,
    FinancingModule,
    LeaseModule,
    TradeInModule,
    ApplicationsModule,
    PaymentsModule,
    NotificationsModule,
    BranchesModule,
    FulfilmentModule,
    ContentModule,
    ReportingModule,
    AdminModule,
    CountriesModule,
  ],
  providers: [
    // Guard chain order: throttle -> authenticate -> tenant match -> role.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AllTenantsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
