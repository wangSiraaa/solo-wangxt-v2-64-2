import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appeal } from '../entities/appeal.entity';
import { AppealEvent } from '../entities/appeal-event.entity';
import { AppealDecision } from '../entities/appeal-decision.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { FeesModule } from '../fees/fees.module';
import { AppealsController } from './appeals.controller';
import { AppealsService } from './appeals.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Appeal,
      AppealEvent,
      AppealDecision,
      NotificationRecord,
      AssessmentCase,
    ]),
    FeesModule,
  ],
  controllers: [AppealsController],
  providers: [AppealsService],
})
export class AppealsModule {}
