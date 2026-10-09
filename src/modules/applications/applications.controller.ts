import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { DecisionDto } from './dto/decision.dto';
import { ListApplicationsDto } from './dto/list-applications.dto';

const STAFF = [Role.ApprovalsOfficer, Role.CountryManager, Role.SuperAdmin] as const;

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly apps: ApplicationsService) {}

  @Post()
  @Roles(Role.Customer)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateApplicationDto,
  ) {
    return this.apps.create(tenantId, user, dto);
  }

  @Patch(':id')
  @Roles(Role.Customer)
  update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ) {
    return this.apps.update(tenantId, user, id, dto);
  }

  @Post(':id/submit')
  @Roles(Role.Customer)
  @HttpCode(200)
  submit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.apps.submit(tenantId, user, id, idemKey);
  }

  @Post(':id/withdraw')
  @Roles(Role.Customer)
  @HttpCode(200)
  withdraw(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.apps.withdraw(tenantId, user, id);
  }

  @Post(':id/agreement')
  @Roles(Role.Customer)
  @HttpCode(200)
  agreement(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.apps.acceptAgreement(tenantId, user, id);
  }

  @Post(':id/activate')
  @Roles(...STAFF)
  @HttpCode(200)
  activate(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.apps.activate(tenantId, user, id);
  }

  // Customers see their own; decision staff see the whole tenant queue.
  @Get()
  list(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListApplicationsDto,
  ) {
    return this.apps.list(tenantId, user, query);
  }

  @Get(':id')
  getOne(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.apps.getOne(tenantId, user, id);
  }

  @Post(':id/review')
  @Roles(...STAFF)
  @HttpCode(200)
  review(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.apps.review(tenantId, user, id);
  }

  @Post(':id/decision')
  @Roles(...STAFF)
  @HttpCode(200)
  decide(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.apps.decide(tenantId, user, id, dto, idemKey);
  }
}
