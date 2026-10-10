import { searchKindsFor } from './search-access';

describe('searchKindsFor', () => {
  it('follows each role', () => {
    expect([...searchKindsFor(['product_editor'])].sort()).toEqual(['device', 'order']);
    expect(searchKindsFor(['agent']).has('staff')).toBe(false);
    expect(searchKindsFor(['super_admin']).size).toBe(5);
  });

  it("follows a delegated admin's areas", () => {
    const kinds = searchKindsFor(['admin'], {
      orders: 'view',
      staff: 'manage',
      payments: 'manage',
    });
    expect([...kinds].sort()).toEqual(['order', 'staff']);
    expect(searchKindsFor(['admin'], {}).size).toBe(0);
  });
});
