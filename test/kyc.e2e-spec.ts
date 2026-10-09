import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applySchema, createApp, seedTenants, SmsCapture, startPostgres } from './e2e-setup';

const GAMBIA = 'gambia.norex.com';

describe('KYC (integration, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let sms: SmsCapture;
  let prisma: PrismaClient;

  let aToken: string;
  let bToken: string;
  let officerToken: string;
  let profileId: string;
  let frontDocId: string;

  jest.setTimeout(180000);

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => (r: request.Test) =>
    r.set('Host', GAMBIA).set('Authorization', `Bearer ${t}`);

  async function customerToken(phone: string): Promise<string> {
    await http().post('/api/auth/otp/request').set('Host', GAMBIA).send({ phone }).expect(200);
    const res = await http()
      .post('/api/auth/otp/verify')
      .set('Host', GAMBIA)
      .send({ phone, code: sms.code() })
      .expect(200);
    return res.body.accessToken;
  }

  async function officer(): Promise<string> {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: 'gambia' } });
    const password = 'staff-password-123';
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'kyc-officer@norex.gm',
        isStaff: true,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        roles: { create: { tenantId: tenant.id, role: Role.approvals_officer } },
      },
    });
    const l = await http()
      .post('/api/auth/staff/login')
      .set('Host', GAMBIA)
      .send({ email: 'kyc-officer@norex.gm', password })
      .expect(200);
    const r = await http()
      .post('/api/auth/staff/2fa')
      .set('Host', GAMBIA)
      .send({ challengeId: l.body.challengeId, totp: authenticator.generate(l.body.secret) })
      .expect(200);
    return r.body.accessToken;
  }

  async function uploadDoc(token: string, kind: string): Promise<string> {
    const u = await auth(token)(http().post('/api/kyc/me/documents/upload-url'))
      .send({ kind, contentType: 'image/png', bytes: 1000 })
      .expect(201);
    const c = await auth(token)(http().post('/api/kyc/me/documents'))
      .send({ kind, storageKey: u.body.storageKey, contentType: 'image/png', bytes: 1000 })
      .expect(201);
    return c.body.id;
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const url = pg.getConnectionUri();
    applySchema(url);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedTenants(prisma);
    ({ app, sms } = await createApp(url));
    aToken = await customerToken('+2203200001');
    bToken = await customerToken('+2203200002');
    officerToken = await officer();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('captures the profile, encrypts the ID number (last4 only), validates the regex', async () => {
    await auth(aToken)(http().put('/api/kyc/me'))
      .send({ idTypeCode: 'gambia_id', idNumber: 'abc' })
      .expect(400);

    const res = await auth(aToken)(http().put('/api/kyc/me'))
      .send({
        idTypeCode: 'gambia_id',
        idNumber: '123456',
        address: { line1: '1 St', city: 'Banjul' },
        employment: { employer: 'ACME' },
      })
      .expect(200);
    expect(res.body.profile.idNumberLast4).toBe('3456');
    expect(res.body.profile).not.toHaveProperty('idNumber');
    expect(res.body.completeness.complete).toBe(false);
    expect(res.body.completeness.missing).toEqual(
      expect.arrayContaining(['guarantor', 'id_front', 'id_back', 'proof_of_address']),
    );
  });

  it('reaches complete once guarantor + required documents exist', async () => {
    await auth(aToken)(http().put('/api/kyc/me/guarantor'))
      .send({ fullName: 'Awa Ceesay', phone: '+2203009999', relationship: 'sister' })
      .expect(200);
    frontDocId = await uploadDoc(aToken, 'id_front');
    await uploadDoc(aToken, 'id_back');
    await uploadDoc(aToken, 'proof_of_address');
    const me = await auth(aToken)(http().get('/api/kyc/me')).expect(200);
    expect(me.body.completeness.complete).toBe(true);
  });

  it('rejects an unsupported document type', async () => {
    await auth(aToken)(http().post('/api/kyc/me/documents/upload-url'))
      .send({ kind: 'selfie', contentType: 'text/plain', bytes: 100 })
      .expect(400);
  });

  it('enforces national-ID uniqueness within a tenant', async () => {
    await auth(bToken)(http().put('/api/kyc/me'))
      .send({
        idTypeCode: 'gambia_id',
        idNumber: '123456',
        address: { line1: '2 St' },
        employment: { employer: 'X' },
      })
      .expect(409);
  });

  it('lets staff decrypt (logged) and verify; customers cannot list profiles', async () => {
    await auth(aToken)(http().get('/api/kyc/profiles')).expect(403);

    const list = await auth(officerToken)(http().get('/api/kyc/profiles')).expect(200);
    const row = list.body.data.find((p: { idNumberLast4: string }) => p.idNumberLast4 === '3456');
    expect(row).toHaveProperty('idNumberLast4', '3456');
    expect(row).not.toHaveProperty('idNumber');
    profileId = row.id;

    const full = await auth(officerToken)(http().get(`/api/kyc/profiles/${profileId}`)).expect(200);
    expect(full.body.idNumber).toBe('123456'); // decrypted for authorized staff

    const logs = await prisma.kycAccessLog.count({
      where: { kycProfileId: profileId, action: 'view_id_number' },
    });
    expect(logs).toBeGreaterThan(0);

    const verified = await auth(officerToken)(http().post(`/api/kyc/profiles/${profileId}/verify`))
      .send({ decision: 'verify' })
      .expect(200);
    expect(verified.body.status).toBe('verified');
  });

  it('scopes document URLs to the owner', async () => {
    await auth(aToken)(http().get(`/api/kyc/me/documents/${frontDocId}/url`)).expect(200);
    await auth(bToken)(http().get(`/api/kyc/me/documents/${frontDocId}/url`)).expect(404); // not B's document
  });
});
