import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationEventKey,
  NotificationStatus,
  PushPlatform,
} from '@prisma/client';

export class UpdatePreferenceDto {
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  // Marketing only — a transactional opt-out is rejected in the service.
  @IsEnum(NotificationCategory) category!: NotificationCategory;
  @IsBoolean() optedIn!: boolean;
}

export class RegisterPushTokenDto {
  @IsEnum(PushPlatform) platform!: PushPlatform;
  @IsString() @Length(8, 500) token!: string;
  @IsOptional() @IsString() @Length(1, 128) deviceId?: string;
}

export class CreateTemplateDto {
  @IsEnum(NotificationEventKey) eventKey!: NotificationEventKey;
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  @IsString() @Length(2, 10) locale!: string;
  @IsOptional() @IsString() @Length(1, 200) subject?: string;
  @IsString() @Length(1, 2000) body!: string;
  @IsOptional() @IsString() @Length(1, 120) whatsappTemplateName?: string;
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @Length(1, 200) subject?: string;
  @IsOptional() @IsString() @Length(1, 2000) body?: string;
  @IsOptional() @IsString() @Length(1, 120) whatsappTemplateName?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class TestSendDto {
  @IsUUID() templateId!: string;
  @IsString() @Length(3, 200) to!: string;
  @IsOptional() @IsObject() vars?: Record<string, string | number>;
}

export class ConfigureChannelProviderDto {
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  @IsString() @Length(2, 40) provider!: string;
  @IsObject() senderConfig!: Record<string, unknown>;
  @IsOptional() @IsString() @Length(2, 200) secretRef?: string;
}

export class ListTemplatesDto {
  @IsOptional() @IsEnum(NotificationEventKey) eventKey?: NotificationEventKey;
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;
  @IsOptional() @IsString() @Length(2, 10) locale?: string;
}

export class ListNotificationsDto {
  @IsOptional() @IsEnum(NotificationStatus) status?: NotificationStatus;
  @IsOptional() @IsEnum(NotificationEventKey) eventKey?: NotificationEventKey;
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;
}
