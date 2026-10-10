import { OrderStatus } from '@prisma/client';
import { canOrderTransition, ORDER_REFERENCE } from './order.constants';

describe('order.constants', () => {
  it('only reaches completed from ready (after payment + hand-over)', () => {
    expect(canOrderTransition(OrderStatus.placed, OrderStatus.completed)).toBe(false);
    expect(canOrderTransition(OrderStatus.confirmed, OrderStatus.completed)).toBe(false);
    expect(canOrderTransition(OrderStatus.ready, OrderStatus.completed)).toBe(true);
  });

  it('never leaves a terminal state', () => {
    expect(canOrderTransition(OrderStatus.completed, OrderStatus.cancelled)).toBe(false);
    expect(canOrderTransition(OrderStatus.cancelled, OrderStatus.placed)).toBe(false);
  });

  it('matches website references only', () => {
    expect(ORDER_REFERENCE.test('ORD-AB23CD')).toBe(true);
    expect(ORDER_REFERENCE.test('ORD-AB0OCD')).toBe(false);
    expect(ORDER_REFERENCE.test('BNP-AB23CD')).toBe(false);
  });
});
