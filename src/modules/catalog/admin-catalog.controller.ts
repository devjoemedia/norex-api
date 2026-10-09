import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CatalogService } from './catalog.service';
import { AdminListDto, CreateDeviceDto, UpdateDeviceDto } from './dto/device.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { CreateBrandDto, CreateCategoryDto } from './dto/taxonomy.dto';
import { ConfirmMediaDto, MediaUploadUrlDto } from './dto/media.dto';

// product_editor manages content; publish/archive/stock/price are country_manager only.
const EDIT = [Role.ProductEditor, Role.CountryManager] as const;

@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('devices')
  @Roles(...EDIT)
  list(@TenantId() tenantId: string, @Query() q: AdminListDto) {
    return this.catalog.adminList(tenantId, q);
  }

  @Post('devices')
  @Roles(...EDIT)
  create(@TenantId() tenantId: string, @CurrentUser() a: AuthUser, @Body() dto: CreateDeviceDto) {
    return this.catalog.createDevice(a, tenantId, dto);
  }

  @Patch('devices/:id')
  @Roles(...EDIT)
  update(
    @TenantId() tenantId: string,
    @CurrentUser() a: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
  ) {
    return this.catalog.updateDevice(a, tenantId, id, dto);
  }

  @Post('devices/:id/publish')
  @Roles(Role.CountryManager)
  @HttpCode(200)
  publish(@TenantId() tenantId: string, @CurrentUser() a: AuthUser, @Param('id') id: string) {
    return this.catalog.publish(a, tenantId, id);
  }

  @Post('devices/:id/archive')
  @Roles(Role.CountryManager)
  @HttpCode(200)
  archive(@TenantId() tenantId: string, @CurrentUser() a: AuthUser, @Param('id') id: string) {
    return this.catalog.archive(a, tenantId, id);
  }

  @Post('devices/:id/variants')
  @Roles(Role.CountryManager)
  createVariant(
    @TenantId() tenantId: string,
    @CurrentUser() a: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.catalog.createVariant(a, tenantId, id, dto);
  }

  @Patch('variants/:id')
  @Roles(Role.CountryManager)
  updateVariant(
    @TenantId() tenantId: string,
    @CurrentUser() a: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.catalog.updateVariant(a, tenantId, id, dto);
  }

  @Post('devices/:id/media/upload-url')
  @Roles(...EDIT)
  @HttpCode(200)
  uploadUrl(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: MediaUploadUrlDto) {
    return this.catalog.mediaUploadUrl(tenantId, id, dto);
  }

  @Post('devices/:id/media')
  @Roles(...EDIT)
  confirmMedia(
    @TenantId() tenantId: string,
    @CurrentUser() a: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConfirmMediaDto,
  ) {
    return this.catalog.confirmMedia(a, tenantId, id, dto);
  }

  @Post('brands')
  @Roles(...EDIT)
  createBrand(
    @TenantId() tenantId: string,
    @CurrentUser() a: AuthUser,
    @Body() dto: CreateBrandDto,
  ) {
    return this.catalog.createBrand(a, tenantId, dto);
  }

  @Get('brands')
  @Roles(...EDIT)
  listBrands(@TenantId() tenantId: string) {
    return this.catalog.listBrands(tenantId);
  }

  @Post('categories')
  @Roles(...EDIT)
  createCategory(
    @TenantId() tenantId: string,
    @CurrentUser() a: AuthUser,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.catalog.createCategory(a, tenantId, dto);
  }

  @Get('categories')
  @Roles(...EDIT)
  listCategories(@TenantId() tenantId: string) {
    return this.catalog.listCategories(tenantId);
  }
}
