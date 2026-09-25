import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { AppealsService } from './appeals.service';
import {
  CreateAppealDto,
  ExpireAppealDto,
  FeeImpactQueryDto,
  RequestCorrectionDto,
  RuleAppealDto,
  SupplementAppealDto,
  WithdrawAppealDto,
} from './dto/appeal.dto';

@Controller('assessments/:caseId/appeals')
export class AppealsController {
  constructor(private readonly service: AppealsService) {}

  @Post()
  async create(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: CreateAppealDto,
  ) {
    return this.service.create(caseId, dto);
  }

  @Get()
  list(@Param('caseId', ParseUUIDPipe) caseId: string) {
    return this.service.listForCase(caseId);
  }

  @Post(':appealId/corrections')
  requestCorrection(
    @Param('appealId', ParseUUIDPipe) appealId: string,
    @Body() dto: RequestCorrectionDto,
  ) {
    return this.service.requestCorrection(appealId, dto);
  }

  @Post(':appealId/supplements')
  async supplement(
    @Param('appealId', ParseUUIDPipe) appealId: string,
    @Body() dto: SupplementAppealDto,
  ) {
    const result = await this.service.supplement(appealId, dto);
    if ('correctionExpired' in result && result.correctionExpired) {
      throw new ConflictException({
        code: 'CORRECTION_DEADLINE_PASSED',
        message: '已超过补正期限，申诉按过期处理',
        appeal: result.appeal,
      });
    }
    return result;
  }

  @Post(':appealId/withdraw')
  withdraw(
    @Param('appealId', ParseUUIDPipe) appealId: string,
    @Body() dto: WithdrawAppealDto,
  ) {
    return this.service.withdraw(appealId, dto);
  }

  @Post(':appealId/expire')
  expire(
    @Param('appealId', ParseUUIDPipe) appealId: string,
    @Body() dto: ExpireAppealDto,
  ) {
    return this.service.expire(appealId, dto);
  }

  @Post(':appealId/ruling')
  rule(
    @Param('appealId', ParseUUIDPipe) appealId: string,
    @Body() dto: RuleAppealDto,
  ) {
    return this.service.rule(appealId, dto);
  }

  @Get(':appealId')
  get(@Param('appealId', ParseUUIDPipe) appealId: string) {
    return this.service.get(appealId);
  }

  @Get(':appealId/fee-impact')
  feeImpact(
    @Param('appealId', ParseUUIDPipe) appealId: string,
    @Query() q: FeeImpactQueryDto,
  ) {
    return this.service.feeImpact(appealId, q.from, q.to);
  }
}
