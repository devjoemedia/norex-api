import { OrderStatus } from '@prisma/client';

// Whitelisted moves; `completed` is reached only through a paid hand-over.
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.placed]: [OrderStatus.confirmed, OrderStatus.cancelled],
  [OrderStatus.confirmed]: [OrderStatus.ready, OrderStatus.cancelled],
  [OrderStatus.ready]: [OrderStatus.completed, OrderStatus.cancelled],
  [OrderStatus.completed]: [],
  [OrderStatus.cancelled]: [],
};

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export const ORDER_REFERENCE = /^ORD-[A-HJ-NP-Z2-9]{6}$/;
export const MAX_ORDER_LINES = 10;
export const MAX_LINE_QUANTITY = 5;
