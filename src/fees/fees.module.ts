import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { GradePeriodsService } from './grade-periods.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssessmentCase,
      GradeEffectivePeriod,
      FeeRateVersion,
    ]),
  ],
  controllers: [FeesController],
  providers: [FeesService, GradePeriodsService],
  exports: [FeesService, GradePeriodsService],
})
export class FeesModule {}
