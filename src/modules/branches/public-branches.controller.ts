import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant.decorator';
import { BranchesService } from './branches.service';
import { ListBranchesDto } from './dto/branches.dto';

// Anonymous branch directory (active branches only; no staff/customer data).
@Controller('branches')
export class PublicBranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Public()
  @Get()
  list(@TenantId() tenantId: string, @Query() q: ListBranchesDto) {
    return this.branches.publicList(tenantId, q);
  }

  @Public()
  @Get(':id')
  detail(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.branches.publicDetail(tenantId, id);
  }
}
