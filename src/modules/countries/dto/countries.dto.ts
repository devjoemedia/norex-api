import {
  IsBoolean,
  Max,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateCountryDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
  @IsOptional() @Matches(/^\+\d{1,4}$/) dialCode?: string;
  @IsOptional() @IsString() @MaxLength(60) idType?: string;
  /** Only while the country has no priced rows (currency is then immutable). */
  @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  // Finance ops (docs/23). Rates are basis points: 150 = 1.5%.
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) deliveryFeeMinor?: number;
  @IsOptional() @IsInt() @Min(0) @Max(2000) agentCommissionBps?: number;
  @IsOptional() @IsInt() @Min(0) @Max(2000) partnerOutletFeeBps?: number;
}

export class AddDomainDto {
  @Matches(/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i, { message: 'host must be a bare domain' })
  host!: string;

  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class CreateCountryManagerDto {
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  @IsEmail() email!: string;
  @IsOptional() @Matches(/^\+?\d{6,15}$/) phone?: string;
}

export class SetManagerStatusDto {
  @IsIn(['active', 'suspended']) status!: 'active' | 'suspended';
}

export class CloneCatalogDto {
  /** Source country slug, e.g. "gambia". */
  @IsString() sourceTenant!: string;

  /** Target major units per 1 source major unit × 1,000,000 (e.g. 2.7 LRD/GMD → 2700000). */
  @IsInt() @Min(1) fxRatePpm!: number;

  /** Rounding step in the target's minor units (e.g. LRD 500 → 50000; GNF 10,000 → 10000). */
  @IsInt() @Min(1) roundingStepMinor!: number;

  @IsOptional() @IsBoolean() includeRates?: boolean;
}

export class CreateCountryDto {
  /** URL-safe id used for sign-in, X-Tenant and subdomains, e.g. "senegal". */
  @Matches(/^[a-z][a-z0-9-]{1,40}$/, { message: 'slug: lowercase letters, digits and dashes' })
  slug!: string;

  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  /** ISO 3166-1 alpha-2, e.g. SN. */
  @Matches(/^[A-Z]{2}$/) country!: string;
  /** ISO 4217, e.g. XOF. Locked once the country has prices. */
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @Matches(/^\+\d{1,4}$/) dialCode!: string;
  @IsString() @MaxLength(60) timezone!: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
  @IsString() @MinLength(2) @MaxLength(60) idType!: string;
  /** Regex for national ID numbers; defaults to 6–20 letters/digits. */
  @IsOptional() @IsString() @MaxLength(120) idNumberRegex?: string;

  /** 1 GMD = ? target currency, × 1,000,000 (pre-fills FLEX minimum fees and the clone). */
  @IsInt() @Min(1) @Max(2_000_000_000) startingFxPpm!: number;
  /** Rounding step in the target's minor units, e.g. XOF 100 → 100 (0 decimals). */
  @IsInt() @Min(1) startingRoundStepMinor!: number;

  /** Launched countries resolve for the public website; default: prepare first. */
  @IsOptional() @IsBoolean() active?: boolean;
}
