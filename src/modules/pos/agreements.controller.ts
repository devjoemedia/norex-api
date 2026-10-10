import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AllowAllTenants } from '../../common/decorators/all-tenants.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { TenantScope, TenantScopeValue } from '../../common/decorators/tenant-scope.decorator';
import { Role } from '../../common/enums/role.enum';
import { AllCountriesService } from '../../common/tenancy/all-countries.service';
import { PrismaService } from '../../database/prisma.service';

const VIEWERS = [Role.SuperAdmin, Role.CountryManager, Role.ApprovalsOfficer, Role.Agent];

// Signed agreements (docs/21): what each customer signed at the counter.
@Controller('admin/agreements')
@Roles(...VIEWERS)
export class AgreementsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly all: AllCountriesService,
  ) {}

  @AllowAllTenants()
  @Get()
  list(@TenantScope() scope: TenantScopeValue) {
    return this.all.listing(scope, async (tenantId) => {
      const rows = await this.prisma.agreement.findMany({
        where: { tenantId },
        orderBy: { signedAt: 'desc' },
        take: 300,
        select: { id: true, applicationId: true, signedName: true, signedAt: true, branchId: true },
      });
      const [apps, branches] = await Promise.all([
        this.prisma.application.findMany({
          where: { tenantId, id: { in: rows.map((r) => r.applicationId) } },
          select: { id: true, reference: true, type: true, deviceId: true, status: true },
        }),
        this.prisma.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      ]);
      const devices = await this.prisma.device.findMany({
        where: { tenantId, id: { in: apps.map((a) => a.deviceId) } },
        select: { id: true, name: true },
      });
      const app = new Map(apps.map((a) => [a.id, a]));
      const device = new Map(devices.map((d) => [d.id, d.name]));
      const branch = new Map(branches.map((b) => [b.id, b.name]));
      return {
        stats: { total: rows.length },
        rows: rows.map((r) => {
          const a = app.get(r.applicationId);
          return {
            id: r.id,
            applicationId: r.applicationId,
            reference: a?.reference ?? null,
            type: a?.type ?? null,
            status: a?.status ?? null,
            device: a ? (device.get(a.deviceId) ?? null) : null,
            signedName: r.signedName,
            signedAt: r.signedAt.toISOString(),
            outlet: r.branchId ? (branch.get(r.branchId) ?? null) : null,
          };
        }),
      };
    });
  }

  @Get(':id')
  async detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.prisma.agreement.findFirst({ where: { tenantId, id } });
    if (!a) throw new NotFoundException('Agreement not found');
    return {
      id: a.id,
      applicationId: a.applicationId,
      text: a.text,
      textSha256: a.textSha256,
      // Recomputed so anyone can see the stored text hasn't changed since signing.
      intact: createHash('sha256').update(a.text).digest('hex') === a.textSha256,
      signedName: a.signedName,
      signedAt: a.signedAt.toISOString(),
      signature: `data:image/png;base64,${Buffer.from(a.signatureImage).toString('base64')}`,
    };
  }
}
