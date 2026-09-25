import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { AppealsService } from './appeals.service';
import {
  AdjudicateAppealDto,
  FileAppealDto,
  SupplementAppealDto,
  WithdrawAppealDto,
} from './dto/appeal.dto';

@Controller()
export class AppealsController {
  constructor(private readonly service: AppealsService) {}

  /** 申诉受理：绑定确认等级/量表答案/送达快照；未送达或超期拒绝受理 */
  @Post('appeals')
  file(@Body() dto: FileAppealDto) {
    return this.service.file(dto);
  }

  /** 补正：家属补充材料 → 待裁决（重复/乱序请求幂等） */
  @Post('appeals/:id/supplement')
  supplement(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SupplementAppealDto,
  ) {
    return this.service.supplement(id, dto);
  }

  /** 撤回：进行中 → 已撤回（重复撤回幂等回放；撤回后裁决不生效） */
  @Post('appeals/:id/withdraw')
  withdraw(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: WithdrawAppealDto,
  ) {
    return this.service.withdraw(id, dto);
  }

  /** 裁决：维持 / 变更（变更追加新等级版本并按生效日计算费用影响；并发仅一个成功） */
  @Post('appeals/:id/adjudicate')
  adjudicate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AdjudicateAppealDto,
  ) {
    return this.service.adjudicate(id, dto);
  }

  /** 申诉详情：快照、材料、决定与完整留痕事件 */
  @Get('appeals/:id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }

  /** 案件维度的申诉历史查询 */
  @Get('assessments/:caseId/appeals')
  listForCase(@Param('caseId', new ParseUUIDPipe()) caseId: string) {
    return this.service.listForCase(caseId);
  }
}
