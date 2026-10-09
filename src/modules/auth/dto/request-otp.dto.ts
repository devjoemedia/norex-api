import { Matches } from 'class-validator';

export class RequestOtpDto {
  // E.164-ish: optional +, 7–15 digits.
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone!: string;
}
