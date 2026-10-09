import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applySchema, createApp, seedTenants, SmsCapture, startPostgres } from './e2e-setup';

const GAMBIA = 'gambia.norex.com';
const GHANA = 'ghana.norex.com';

describe('Auth (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let sms: SmsCapture;
  let prisma: PrismaClient;

  jest.setTimeout(180000);

  beforeAll(async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    applySchema(url);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedTenants(prisma);
    ({ app, sms } = await createApp(url));
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  const http = () => request(app.getHttpServer());

  async function customerLogin(phone: string, host = GAMBIA) {
    await http().post('/api/auth/otp/request').set('Host', host).send({ phone }).expect(200);
    const code = sms.code();
    const res = await http()
      .post('/api/auth/otp/verify')
      .set('Host', host)
      .send({ phone, code })
      .expect(200);
    return res.body as {
      accessToken: string;
      refreshToken: string;
      user: { roles: string[]; phone: string };
    };
  }

  async function makeStaff(email: string, password: string, roles: Role[]) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        isStaff: true,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        roles: { create: roles.map((role) => ({ tenantId: tenant.id, role })) },
      },
    });
  }

  // Password -> enroll TOTP -> tokens. Returns an access token + the TOTP secret.
  async function enrollStaff(email: string, password: string) {
    const l1 = await http()
      .post('/api/auth/staff/login')
      .set('Host', GAMBIA)
      .send({ email, password })
      .expect(200);
    expect(l1.body.status).toBe('enroll_2fa');
    const { challengeId, secret } = l1.body;
    const r = await http()
      .post('/api/auth/staff/2fa')
      .set('Host', GAMBIA)
      .send({ challengeId, totp: authenticator.generate(secret) })
      .expect(200);
    return {
      accessToken: r.body.accessToken as string,
      secret: secret as string,
      recoveryCodes: r.body.recoveryCodes as string[],
    };
  }

  describe('customer phone/OTP', () => {
    it('request -> verify issues tokens and provisions a customer', async () => {
      const res = await customerLogin('+2203000001');
      expect(res.accessToken).toBeDefined();
      expect(res.refreshToken).toContain('.');
      expect(res.user.roles).toEqual(['customer']);
    });

    it('rejects a wrong code', async () => {
      await http()
        .post('/api/auth/otp/request')
        .set('Host', GAMBIA)
        .send({ phone: '+2203000002' })
        .expect(200);
      await http()
        .post('/api/auth/otp/verify')
        .set('Host', GAMBIA)
        .send({ phone: '+2203000002', code: '000000' })
        .expect(401);
    });

    it('validates the phone number', async () => {
      await http()
        .post('/api/auth/otp/request')
        .set('Host', GAMBIA)
        .send({ phone: 'not-a-phone' })
        .expect(400);
    });

    it('rejects unknown-tenant hosts', async () => {
      await http()
        .post('/api/auth/otp/request')
        .set('Host', 'nowhere.norex.com')
        .send({ phone: '+2203000003' })
        .expect(400);
    });
  });

  describe('token lifecycle', () => {
    it('refresh rotates and reuse revokes the whole family', async () => {
      const { refreshToken } = await customerLogin('+2203000010');
      const rotated = await http()
        .post('/api/auth/refresh')
        .set('Host', GAMBIA)
        .send({ refreshToken })
        .expect(200);
      const newRefresh = rotated.body.refreshToken as string;
      expect(newRefresh).not.toEqual(refreshToken);

      // Replaying the old (superseded) token is detected as reuse -> 401 ...
      await http().post('/api/auth/refresh').set('Host', GAMBIA).send({ refreshToken }).expect(401);
      // ... and the family is revoked, so even the rotated token no longer works.
      await http()
        .post('/api/auth/refresh')
        .set('Host', GAMBIA)
        .send({ refreshToken: newRefresh })
        .expect(401);
    });

    it('me works, and logout revokes the session', async () => {
      const { accessToken, refreshToken, user } = await customerLogin('+2203000011');
      const me = await http()
        .get('/api/me')
        .set('Host', GAMBIA)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(me.body.phone).toBe(user.phone);

      await http()
        .post('/api/auth/logout')
        .set('Host', GAMBIA)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
      await http().post('/api/auth/refresh').set('Host', GAMBIA).send({ refreshToken }).expect(401);
    });

    it('rejects requests with no token', async () => {
      await http().get('/api/me').set('Host', GAMBIA).expect(401);
    });
  });

  describe('tenant isolation', () => {
    it('a token minted for one tenant is rejected on another', async () => {
      const { accessToken } = await customerLogin('+2203000020', GAMBIA);
      await http()
        .get('/api/me')
        .set('Host', GHANA)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('the same phone is a separate account per tenant', async () => {
      const g = await customerLogin('+2203000021', GAMBIA);
      const h = await customerLogin('+2203000021', GHANA);
      expect(g.user.roles).toEqual(['customer']);
      expect(h.user.roles).toEqual(['customer']);
      const count = await prisma.user.count({ where: { phone: '+2203000021' } });
      expect(count).toBe(2);
    });
  });

  describe('staff password + TOTP', () => {
    const email = 'ops@norex.gm';
    const password = 'staff-password-123';

    beforeAll(async () => {
      await makeStaff(email, password, [Role.super_admin]);
    });

    it('enrolls TOTP on first login and returns recovery codes', async () => {
      const { accessToken, recoveryCodes } = await enrollStaff(email, password);
      expect(accessToken).toBeDefined();
      expect(recoveryCodes).toHaveLength(8);
    });

    it('subsequent login is gated by 2FA and rejects a wrong TOTP', async () => {
      const l = await http()
        .post('/api/auth/staff/login')
        .set('Host', GAMBIA)
        .send({ email, password })
        .expect(200);
      expect(l.body.status).toBe('2fa_required');
      await http()
        .post('/api/auth/staff/2fa')
        .set('Host', GAMBIA)
        .send({ challengeId: l.body.challengeId, totp: '000000' })
        .expect(401);
    });

    it('rejects a wrong password uniformly (no enumeration)', async () => {
      await http()
        .post('/api/auth/staff/login')
        .set('Host', GAMBIA)
        .send({ email, password: 'nope-nope-nope' })
        .expect(401);
      await http()
        .post('/api/auth/staff/login')
        .set('Host', GAMBIA)
        .send({ email: 'ghost@norex.gm', password })
        .expect(401);
    });
  });

  describe('RBAC on admin endpoints', () => {
    it('super_admin can create staff; a customer cannot', async () => {
      await makeStaff('admin@norex.gm', 'admin-password-123', [Role.super_admin]);
      const { accessToken } = await enrollStaff('admin@norex.gm', 'admin-password-123');

      await http()
        .post('/api/admin/staff')
        .set('Host', GAMBIA)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          email: 'editor@norex.gm',
          password: 'editor-password-123',
          roles: ['product_editor'],
        })
        .expect(201);

      const cust = await customerLogin('+2203000030');
      await http()
        .post('/api/admin/staff')
        .set('Host', GAMBIA)
        .set('Authorization', `Bearer ${cust.accessToken}`)
        .send({ email: 'blocked@norex.gm', password: 'whatever-123456', roles: ['product_editor'] })
        .expect(403);
    });
  });
});
