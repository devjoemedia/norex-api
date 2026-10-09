import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { CountriesService } from './countries.service';
import {
  AddDomainDto,
  CloneCatalogDto,
  CreateCountryDto,
  CreateCountryManagerDto,
  SetManagerStatusDto,
  UpdateCountryDto,
} from './dto/countries.dto';

// Country set-up (docs/15). The country is the :tenant slug in the path, so these
// work from the hq tenant; everything except the list is Super Admin only.
@Roles(Role.SuperAdmin)
@Controller('admin/countries')
export class CountriesController {
  constructor(private readonly countries: CountriesService) {}

  @Roles(Role.SuperAdmin, Role.CountryManager)
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.countries.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCountryDto) {
    return this.countries.create(user, dto);
  }

  @Patch(':tenant')
  update(
    @CurrentUser() user: AuthUser,
    @Param('tenant') slug: string,
    @Body() dto: UpdateCountryDto,
  ) {
    return this.countries.update(user, slug, dto);
  }

  @Post(':tenant/domains')
  addDomain(
    @CurrentUser() user: AuthUser,
    @Param('tenant') slug: string,
    @Body() dto: AddDomainDto,
  ) {
    return this.countries.addDomain(user, slug, dto);
  }

  @Delete(':tenant/domains/:id')
  removeDomain(
    @CurrentUser() user: AuthUser,
    @Param('tenant') slug: string,
    @Param('id') id: string,
  ) {
    return this.countries.removeDomain(user, slug, id);
  }

  @Get(':tenant/managers')
  managers(@Param('tenant') slug: string) {
    return this.countries.managers(slug);
  }

  @Post(':tenant/managers')
  createManager(
    @CurrentUser() user: AuthUser,
    @Param('tenant') slug: string,
    @Body() dto: CreateCountryManagerDto,
  ) {
    return this.countries.createManager(user, slug, dto);
  }

  @Patch(':tenant/managers/:userId')
  setManagerStatus(
    @CurrentUser() user: AuthUser,
    @Param('tenant') slug: string,
    @Param('userId') userId: string,
    @Body() dto: SetManagerStatusDto,
  ) {
    return this.countries.setManagerStatus(user, slug, userId, dto.status);
  }

  @Post(':tenant/catalog/clone')
  clone(
    @CurrentUser() user: AuthUser,
    @Param('tenant') slug: string,
    @Body() dto: CloneCatalogDto,
  ) {
    return this.countries.startClone(user, slug, dto);
  }

  @Get(':tenant/catalog/clone/:jobId')
  cloneStatus(@Param('tenant') slug: string, @Param('jobId') jobId: string) {
    return this.countries.cloneStatus(slug, jobId);
  }
}

// Country names for the portal's sign-in page, before anyone is signed in.
@Controller('countries')
export class PublicCountriesController {
  constructor(private readonly countries: CountriesService) {}

  @Public()
  @Get()
  list() {
    return this.countries.publicList();
  }
}
