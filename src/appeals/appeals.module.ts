import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appeal } from '../entities/appeal.entity';
import { AppealEvent } from '../entities/appeal-event.entity';
import { AppealMaterial } from '../entities/appeal-material.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { GradeVersion } from '../entities/grade-version.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { FeesModule } from '../fees/fees.module';
import { AppealsController } from './appeals.controller';
import { AppealsService } from './appeals.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Appeal,
      AppealEvent,
      AppealMaterial,
      AssessmentCase,
      NotificationRecord,
      GradeVersion,
      ReviewDecision,
      AssessorAnswer,
      GradeEffectivePeriod,
      FeeRateVersion,
    ]),
    FeesModule,
  ],
  controllers: [AppealsController],
  providers: [AppealsService],
})
export class AppealsModule {}
