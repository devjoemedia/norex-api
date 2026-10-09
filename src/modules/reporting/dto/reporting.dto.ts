import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApplicationStatus, ApplicationType, ExportFormat, ExportStatus } from '@prisma/client';

// Report keys that can be requested/exported. Allow-listed so filters can never
// reach an arbitrary table/column (docs/13 — validation).
export const REPORT_KEYS = ['applications', 'finance', 'inventory', 'lease-returns'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

// Shared bounded date window. The `from <= to` and max-window checks run in the
// service (so the service is the single source of truth for the bound).
export class DateRangeDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}

export class ApplicationsReportDto extends DateRangeDto {
  @IsOptional() @IsIn(Object.values(ApplicationType)) type?: ApplicationType;
  @IsOptional() @IsIn(Object.values(ApplicationStatus)) status?: ApplicationStatus;
}

export class FinanceReportDto extends DateRangeDto {
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
}

// inventory + lease-returns take the plain range only.
export class InventoryReportDto extends DateRangeDto {}
export class LeaseReturnsReportDto extends DateRangeDto {}

export class CreateExportDto {
  @IsIn(REPORT_KEYS) reportKey!: ReportKey;
  @IsIn(Object.values(ExportFormat)) format!: ExportFormat;
  // Date range / filters only, no PII (docs/13). Shape is validated when the report
  // is generated (the same bounded-range check as the dashboard endpoints).
  @IsOptional() @IsObject() params?: Record<string, unknown>;
}

export class ListExportsDto {
  @IsOptional() @IsIn(Object.values(ExportStatus)) status?: ExportStatus;
  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}

export class RefreshRollupsDto {
  /** How many days back from today to recompute (default 30, max 366). */
  @IsOptional() @IsInt() @Min(1) @Max(366) days?: number;
}
