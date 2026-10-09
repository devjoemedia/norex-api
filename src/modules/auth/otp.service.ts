import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { SmsService } from '../notifications/sms.service';
import { keyedHash, numericOtp, safeEqualHex } from '../../common/crypto/hash.util';

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
  ) {}

  private pepper(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }

  private hash(tenantId: string, phone: string, code: string): string {
    return keyedHash(this.pepper(), `${tenantId}:${phone}:${code}`);
  }

  // Issues a fresh OTP, invalidating any previous unconsumed code for this phone.
  async request(tenantId: string, phone: string, ip?: string): Promise<void> {
    const recent = await this.prisma.otpRequest.findFirst({
      where: { tenantId, phone },
      orderBy: { createdAt: 'desc' },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
      throw new HttpException(
        'Please wait before requesting another code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.prisma.otpRequest.updateMany({
      where: { tenantId, phone, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = numericOtp(OTP_LENGTH);
    await this.prisma.otpRequest.create({
      data: {
        tenantId,
        phone,
        codeHash: this.hash(tenantId, phone, code),
        purpose: 'login',
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        ip,
      },
    });

    await this.sms.send(phone, `Your Norex verification code is ${code}. It expires in 5 minutes.`);
  }

  // Verifies a code. Single-use, attempt-limited, timing-safe. Throws on failure.
  async verify(tenantId: string, phone: string, code: string): Promise<void> {
    const otp = await this.prisma.otpRequest.findFirst({
      where: { tenantId, phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('Invalid or expired code');

    if (otp.attempts >= MAX_ATTEMPTS) {
      await this.prisma.otpRequest.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      });
      throw new UnauthorizedException('Too many attempts — request a new code');
    }

    const ok = safeEqualHex(this.hash(tenantId, phone, code), otp.codeHash);
    if (!ok) {
      await this.prisma.otpRequest.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid code');
    }

    await this.prisma.otpRequest.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });
  }
}
