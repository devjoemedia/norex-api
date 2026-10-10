import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, ApplicationType, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

// "Where's my application/order?" for customers without an account (docs/16). A
// reference alone isn't enough: the phone number used on it must match too, and both
// "not found" and "wrong phone" give the same answer, so references can't be probed.

export interface TrackStep {
  stage: string;
  label: string;
  note: string;
  done: boolean;
  current: boolean;
}

export interface TrackResult {
  kind: 'application' | 'order';
  reference: string;
  title: string;
  submittedAt: string;
  outcome: 'in_progress' | 'approved' | 'declined' | 'completed' | 'cancelled';
  steps: TrackStep[];
}

const NOT_FOUND = "We couldn't find that reference with this phone number";

/** Same number if the last 7 digits match (+220 3001122 vs 3001122). */
export function samePhone(a: string | null | undefined, b: string): boolean {
  const da = (a ?? '').replace(/\D/g, '');
  const db = b.replace(/\D/g, '');
  return da.length >= 7 && db.length >= 7 && da.slice(-7) === db.slice(-7);
}

@Injectable()
export class TrackService {
  constructor(private readonly prisma: PrismaService) {}

  async track(tenantId: string, reference: string, phone: string): Promise<TrackResult> {
    const ref = reference.trim().toUpperCase();
    if (ref.startsWith('ORD-')) {
      const order = await this.prisma.order.findFirst({
        where: { tenantId, reference: ref },
        include: { items: true },
      });
      const owner = order
        ? await this.prisma.user.findFirst({ where: { tenantId, id: order.customerId } })
        : null;
      if (!order || !samePhone(owner?.phone, phone)) throw new NotFoundException(NOT_FOUND);
      const count = order.items.reduce((n, i) => n + i.quantity, 0);
      return {
        kind: 'order',
        reference: order.reference,
        title: order.items.length === 1 ? order.items[0].name : `${count} items`,
        submittedAt: order.createdAt.toISOString(),
        outcome:
          order.status === OrderStatus.completed
            ? 'completed'
            : order.status === OrderStatus.cancelled
              ? 'cancelled'
              : 'in_progress',
        steps: orderSteps(order.status, order.fulfilmentMethod),
      };
    }

    const app = await this.prisma.application.findFirst({ where: { tenantId, reference: ref } });
    const owner = app
      ? await this.prisma.user.findFirst({ where: { tenantId, id: app.customerId } })
      : null;
    if (!app || !samePhone(owner?.phone, phone)) throw new NotFoundException(NOT_FOUND);
    const device = await this.prisma.device.findFirst({
      where: { tenantId, id: app.deviceId },
      select: { name: true },
    });
    return {
      kind: 'application',
      reference: app.reference ?? ref,
      title: device?.name ?? 'Your device',
      submittedAt: (app.submittedAt ?? app.createdAt).toISOString(),
      outcome:
        app.status === ApplicationStatus.declined || app.status === ApplicationStatus.withdrawn
          ? 'declined'
          : app.status === ApplicationStatus.active
            ? 'completed'
            : app.status === ApplicationStatus.approved ||
                app.status === ApplicationStatus.agreement_pending
              ? 'approved'
              : 'in_progress',
      steps: applicationSteps(app.status, app.type),
    };
  }
}

const APP_RANK: Partial<Record<ApplicationStatus, number>> = {
  draft: 1,
  submitted: 2, // in the review queue as soon as it arrives
  under_review: 2,
  info_requested: 2,
  approved: 3,
  declined: 3,
  agreement_pending: 4,
  active: 5,
  withdrawn: 2,
};

export function applicationSteps(status: ApplicationStatus, type: ApplicationType): TrackStep[] {
  const rank = APP_RANK[status] ?? 1;
  const step = (n: number, stage: string, label: string, note: string): TrackStep => ({
    stage,
    label,
    note,
    done: rank > n,
    current: rank === n,
  });
  const received = step(1, 'submitted', 'Received', 'We have your application.');
  if (status === ApplicationStatus.withdrawn) {
    return [
      { ...received, done: true, current: false },
      {
        stage: 'review',
        label: 'Withdrawn',
        note: 'This application was withdrawn.',
        done: false,
        current: true,
      },
    ];
  }
  const review = step(
    2,
    'review',
    'Under review',
    status === ApplicationStatus.info_requested
      ? 'We need a little more information. Check your email, or wait for our call.'
      : 'Our team is checking your details. This usually takes one working day.',
  );
  if (status === ApplicationStatus.declined) {
    return [
      received,
      review,
      {
        stage: 'approved',
        label: 'Not approved',
        note: "We couldn't approve this application. You can apply again later, or buy with cash.",
        done: false,
        current: true,
      },
    ];
  }
  const collectNote =
    type === ApplicationType.trade_in
      ? 'Bring your old phone to the outlet to complete the swap.'
      : status === ApplicationStatus.agreement_pending
        ? 'Sign your agreement and pay the deposit at the outlet, then take your phone home.'
        : 'Our team will contact you to arrange collection. Bring your ID.';
  return [
    received,
    review,
    step(3, 'approved', 'Approved', 'Your application is approved.'),
    step(4, 'ready', 'Collect your device', collectNote),
    ...(rank >= 5
      ? [
          {
            stage: 'active',
            label: 'Collected',
            note: 'Your plan is active.',
            done: true,
            current: false,
          },
        ]
      : []),
  ];
}

const ORDER_RANK: Record<OrderStatus, number> = {
  placed: 1,
  confirmed: 2,
  ready: 3,
  completed: 5,
  cancelled: 1,
};

export function orderSteps(status: OrderStatus, fulfilment: string): TrackStep[] {
  const rank = ORDER_RANK[status];
  const step = (n: number, stage: string, label: string, note: string): TrackStep => ({
    stage,
    label,
    note,
    done: rank > n,
    current: rank === n,
  });
  const received = step(1, 'submitted', 'Order received', 'We have your order.');
  if (status === OrderStatus.cancelled) {
    return [
      { ...received, done: true, current: false },
      {
        stage: 'cancelled',
        label: 'Cancelled',
        note: 'This order was cancelled. Nothing was charged.',
        done: false,
        current: true,
      },
    ];
  }
  const delivery = fulfilment === 'delivery';
  return [
    received,
    step(2, 'review', 'Confirmed', "We've reserved your items."),
    step(
      3,
      'ready',
      delivery ? 'On its way' : 'Ready for collection',
      delivery
        ? 'Our courier will call you before delivering. Pay in cash on delivery.'
        : 'Collect at the outlet and pay in cash. Bring your reference and ID.',
    ),
    step(4, 'active', delivery ? 'Delivered' : 'Collected', 'Paid and handed over.'),
  ];
}
