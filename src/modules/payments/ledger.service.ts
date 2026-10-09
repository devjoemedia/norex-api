import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { LedgerAccount, LedgerDirection, Prisma } from '@prisma/client';

export interface LedgerLeg {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountMinor: number;
}

export interface PostContext {
  paymentId?: string;
  installmentId?: string;
  memo?: string;
}

// Append-only double-entry ledger. Every post is balanced (sum of debits == sum of
// credits) and written inside the caller's transaction. Entries are never updated or
// deleted; corrections are compensating posts (docs/09).
@Injectable()
export class LedgerService {
  post(
    tx: Prisma.TransactionClient,
    tenantId: string,
    currency: string,
    legs: LedgerLeg[],
    ctx: PostContext = {},
  ): Promise<Prisma.BatchPayload> {
    const debit = legs
      .filter((l) => l.direction === LedgerDirection.debit)
      .reduce((s, l) => s + l.amountMinor, 0);
    const credit = legs
      .filter((l) => l.direction === LedgerDirection.credit)
      .reduce((s, l) => s + l.amountMinor, 0);
    if (debit !== credit || debit <= 0) {
      throw new InternalServerErrorException('Unbalanced ledger post');
    }
    return tx.ledgerEntry.createMany({
      data: legs.map((l) => ({
        tenantId,
        account: l.account,
        direction: l.direction,
        amountMinor: l.amountMinor,
        currency,
        paymentId: ctx.paymentId,
        installmentId: ctx.installmentId,
        memo: ctx.memo,
      })),
    });
  }
}
