import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { GradeCode } from '../../common/enums';

export class AppealMaterialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileRef: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreateAppealDto {
  @IsUUID()
  notificationId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  familyRequester: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  reason: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppealMaterialDto)
  @ArrayMaxSize(20)
  materials: AppealMaterialDto[];

  /** 可选：演示用显式指定“今天”，便于测试期限边界；生产可由服务端时间决定 */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  submittedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class RequestCorrectionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  reviewerId: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  requestComment: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class SupplementAppealDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  familyRequester: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  comment: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppealMaterialDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  materials: AppealMaterialDto[];

  @IsOptional()
  @IsString()
  @MaxLength(10)
  submittedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class WithdrawAppealDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  familyRequester: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  submittedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class RuleAppealDto {
  @IsIn([GradeCode.LIGHT, GradeCode.MODERATE, GradeCode.SEVERE])
  confirmedGrade: GradeCode;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  reviewerId: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  comment: string;

  /** CHANGED 时必填：新等级费用生效首日；UPHELD 时忽略 */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  effectiveDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  feeImpactTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class ExpireAppealDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  actorId: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  asOfDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class FeeImpactQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;
}
