import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { TradeInService } from './trade-in.service';
import {
  ConfirmPhotoDto,
  CreateTradeInDto,
  ListTradeInsDto,
  PhotoUploadUrlDto,
  UpdateTradeInDto,
} from './dto/trade-in.dto';

// Customer intake/accept (owner-enforced in the service) + owner-or-staff reads.
@Controller('trade-in')
export class TradeInController {
  constructor(private readonly tradeIn: TradeInService) {}

  @Post()
  @Roles(Role.Customer)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTradeInDto,
  ) {
    return this.tradeIn.create(tenantId, user, dto);
  }

  @Get()
  list(@TenantId() tenantId: string, @CurrentUser() user: AuthUser, @Query() q: ListTradeInsDto) {
    return this.tradeIn.list(tenantId, user, q.status);
  }

  @Get(':id')
  getOne(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tradeIn.getOne(tenantId, user, id);
  }

  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTradeInDto,
  ) {
    return this.tradeIn.update(tenantId, user, id, dto);
  }

  @Post(':id/photos/upload-url')
  photoUploadUrl(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PhotoUploadUrlDto,
  ) {
    return this.tradeIn.photoUploadUrl(tenantId, user, id, dto);
  }

  @Post(':id/photos')
  confirmPhoto(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmPhotoDto,
  ) {
    return this.tradeIn.confirmPhoto(tenantId, user, id, dto);
  }

  @Post(':id/submit')
  submit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tradeIn.submit(tenantId, user, id);
  }

  @Post(':id/accept')
  accept(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tradeIn.accept(tenantId, user, id);
  }
}
