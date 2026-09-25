import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AppealDecisionValue, GradeCode } from '../../common/enums';

export class FileAppealDto {
  /** 被异议的告知记录（必须已送达） */
  @IsUUID()
  notificationId: string;

  /** 异议理由 */
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  reason: string;

  /** 申诉人（家属）标识 */
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  filedBy: string;

  /** 随申诉一并提交的材料清单；为空则进入“待补正” */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  materials?: string[];

  /**
   * 业务申诉日期 YYYY-MM-DD（受理期限判断基准）。
   * 真实系统取服务端当天；演示环境可显式指定以覆盖期限场景。
   */
  @IsOptional()
  @IsDateString()
  filedOn?: string;

  /**
   * 补正期限 YYYY-MM-DD（演示参数；缺省 = 申诉日 + APPEAL_CORRECTION_DAYS）。
   * 仅当受理时材料不足（待补正）有意义。
   */
  @IsOptional()
  @IsDateString()
  correctionDeadline?: string;

  /** 幂等键：重复提交回放首次结果 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class SupplementAppealDto {
  /** 补正材料（追加到既有材料清单） */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  materials: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /** 幂等键：同一申诉内唯一；重复补正回放，不产生重复材料 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class WithdrawAppealDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  withdrawnBy: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  /** 幂等键：重复撤回幂等回放 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class AdjudicateAppealDto {
  /** 裁决结论：UPHELD 维持 / CHANGED 变更 */
  @IsIn([AppealDecisionValue.UPHELD, AppealDecisionValue.CHANGED])
  decision: AppealDecisionValue;

  /** 变更后的新等级（decision=CHANGED 必填，且不得等于被异议等级） */
  @IsOptional()
  @IsIn([GradeCode.LIGHT, GradeCode.MODERATE, GradeCode.SEVERE])
  newGrade?: GradeCode;

  /** 新等级生效日 YYYY-MM-DD（decision=CHANGED 必填） */
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  /** 裁决意见（不改写原复核意见，独立留痕） */
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  comment: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  adjudicatorId: string;

  /** 幂等键：并发/重复裁决仅首次生效 */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}
