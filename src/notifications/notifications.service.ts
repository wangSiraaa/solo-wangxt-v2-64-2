import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import {
  CaseStatus,
  NotifiableStatus,
  NotificationStatus,
} from '../common/enums';
import { NotifyAttemptDto } from './dto/notify-attempt.dto';
import { NotifyChannelService } from './notify-channel.service';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(NotificationRecord)
    private readonly notifRepo: Repository<NotificationRecord>,
    private readonly channel: NotifyChannelService,
  ) {}

  /**
   * 尝试向家属告知。两条维度分开记录、每次尝试独立成行（失败历史可追溯）：
   *  - notifiableStatus：CONFIRMED（等级已确认）/ UNCONFIRMED（尚未确认）
   *  - status：本次送达结果 PENDING / DELIVERED / FAILED
   * 尚未确认也允许尝试，独立落 UNCONFIRMED 记录，不影响后续复核与确认。
   */
  async attempt(caseId: string, dto: NotifyAttemptDto): Promise<NotificationRecord> {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { scaleVersion: true, currentGradeVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    const isConfirmed = assessmentCase.status === CaseStatus.CONFIRMED;
    const forceFail = dto.simulateFail === true;

    const record = new NotificationRecord();
    record.assessmentCase = assessmentCase;
    record.attempts = 1;
    record.lastAttemptAt = new Date();
    record.notifiableStatus = isConfirmed
      ? NotifiableStatus.CONFIRMED
      : NotifiableStatus.UNCONFIRMED;
    if (isConfirmed && assessmentCase.currentGradeVersion) {
      record.gradeVersion = assessmentCase.currentGradeVersion;
      record.gradeVersionId = assessmentCase.currentGradeVersion.id;
    }

    if (isConfirmed) {
      record.message =
        `家属告知：${assessmentCase.elderName} 的` +
        `${assessmentCase.scaleVersion.title}评估等级已确认为 ` +
        `${assessmentCase.confirmedGrade}（虚构行政流程演示，非医疗诊断或护理建议）。`;
    } else {
      record.message =
        `告知尝试：${assessmentCase.elderName} 的评估等级尚未确认` +
        `（案件状态 ${assessmentCase.status}），暂无可告知等级。`;
    }

    const result = await this.channel.send(
      assessmentCase.familyContact,
      record.message,
      forceFail,
    );

    if (result.delivered) {
      if (isConfirmed) {
        record.status = NotificationStatus.DELIVERED;
        record.failureReason = null;
        record.deliveredAt = record.lastAttemptAt;
      } else {
        // 通道虽可达，但等级尚未确认：本次告知业务上记为失败，原因独立标注
        record.status = NotificationStatus.FAILED;
        record.failureReason = '等级尚未确认，无法完成有效告知（通道虽可达）';
      }
    } else {
      record.status = NotificationStatus.FAILED;
      record.failureReason = result.failureReason;
    }

    return this.notifRepo.save(record);
  }

  listForCase(caseId: string) {
    return this.notifRepo.find({
      where: { assessmentCase: { id: caseId } },
      order: { createdAt: 'ASC' },
    });
  }
}
