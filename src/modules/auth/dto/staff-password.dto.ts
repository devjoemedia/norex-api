import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

// Password strength is checked by assertStaffPassword; these only bound the input.
export class SetPasswordDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class InviteTokenDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'This invite link is not valid' })
  token!: string;
}

export class AcceptInviteDto extends InviteTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  newPassword!: string;
}
