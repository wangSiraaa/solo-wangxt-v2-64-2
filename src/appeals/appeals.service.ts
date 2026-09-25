import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import {
  AppealEventType,
  AppealRulingOutcome,
  AppealStatus,
  GradeVersionSource,
  NotifiableStatus,
  NotificationStatus,
} from '../common/enums';
import { addDays, isValidDate } from '../common/date.util';
import { moneyText } from '../common/money.util';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { GradeVersion } from '../entities/grade-version.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { Appeal } from '../entities/appeal.entity';
import { AppealEvent } from '../entities/appeal-event.entity';
import { AppealMaterial } from '../entities/appeal-material.entity';
import { GradePeriodService } from '../fees/grade-period.service';
import {
  CreateAppealDto,
  ExpireAppealDto,
  RequestCorrectionDto,
  RuleAppealDto,
  SupplementAppealDto,
  WithdrawAppealDto,
} from './dto/appeal.dto';

const ACTIVE_STATUSES = [
  AppealStatus.SUBMITTED,
  AppealStatus.PENDING_CORRECTION,
  AppealStatus.PENDING_RULING,
];
const DEADLINE_DAYS = Number(process.env.APPEAL_DEADLINE_DAYS ?? 7);
const CORRECTION_DAYS = Number(process.env.APPEAL_CORRECTION_DAYS ?? 5);

export interface Replay<T> {
  replayed: true;
  message: string;
  appeal: T;
}

@Injectable()
export class AppealsService {
  constructor(
    @InjectRepository(Appeal)
    private readonly appealRepo: Repository<Appeal>,
    private readonly dataSource: DataSource,
    private readonly gradePeriods: GradePeriodService,
  ) {}

  async create(caseId: string, dto: CreateAppealDto) {
    this.validateOptionalDate(dto.submittedDate, 'SUBMITTED_DATE_INVALID');
    return this.dataSource.transaction(async (em) => {
      const assessment = await this.lockCase(em, caseId);
      const notification = await em.findOne(NotificationRecord, {
        where: { id: dto.notificationId, assessmentCase: { id: caseId } },
        relations: { gradeVersion: true },
      });
      if (!notification) throw new NotFoundException('告知记录不存在或不属于该案件');

      if (dto.idempotencyKey) {
        const replayed = await this.findReplay(em, dto.idempotencyKey);
        if (replayed) return this.replayPayload(replayed, '重复申诉请求已幂等回放');
      }

      await this.lockNotification(em, notification.id);
      const existing = await em.findOne(Appeal, {
        where: { notification: { id: notification.id } },
        order: { createdAt: 'DESC' },
      });
      if (existing && ACTIVE_STATUSES.includes(existing.status)) {
        throw new ConflictException({
          code: 'ACTIVE_APPEAL_EXISTS',
          message: '相同告知已有进行中的申诉',
          appealId: existing.id,
        });
      }

      if (
        notification.notifiableStatus !== 'CONFIRMED' ||
        notification.status !== NotificationStatus.DELIVERED
      ) {
        throw new UnprocessableEntityException({
          code: 'NOTIFICATION_NOT_DELIVERED',
          message: '仅已送达的确认等级告知可以在期限内提出申诉；失败/待送达不产生申诉',
        });
      }
      if (!notification.gradeVersionId || !assessment.currentGradeVersionId) {
        throw new UnprocessableEntityException({
          code: 'GRADE_SNAPSHOT_MISSING',
          message: '告知缺少确认等级版本，不能受理申诉',
        });
      }
      if (notification.gradeVersionId !== assessment.currentGradeVersionId) {
        throw new UnprocessableEntityException({
          code: 'NOTIFICATION_GRADE_NOT_CURRENT',
          message: '该告知对应等级不是当前等级版本，请基于最新有效告知提出申诉',
        });
      }

      const deliveredDate = this.dateInUtc(notification.deliveredAt!);
      const submittedDate = dto.submittedDate ?? this.todayUtc();
      const deadlineDate = addDays(deliveredDate, DEADLINE_DAYS);
      if (submittedDate > deadlineDate) {
        throw new UnprocessableEntityException({
          code: 'APPEAL_DEADLINE_PASSED',
          message: `已超过申诉期限 ${deadlineDate}，不能受理`,
          deadlineDate,
        });
      }

      const gradeVersion = await em.findOneOrFail(GradeVersion, {
        where: { id: notification.gradeVersionId },
      });
      const review = await em.findOneOrFail(ReviewDecision, {
        where: { id: gradeVersion.sourceReviewId! },
      });
      const answers = await em.find(AssessorAnswer, {
        where: { assessmentCase: { id: caseId } },
        order: { assessorId: 'ASC', itemCode: 'ASC' },
      });

      const gradeSnapshot = {
        gradeVersionId: gradeVersion.id,
        versionNumber: gradeVersion.versionNumber,
        grade: gradeVersion.grade,
        source: gradeVersion.source,
        review: {
          id: review.id,
          result: review.result,
          reviewerId: review.reviewerId,
          comment: review.comment,
          decidedAt: review.decidedAt,
        },
        case: {
          assessor1Grade: assessment.assessor1Grade,
          assessor2Grade: assessment.assessor2Grade,
          assessor1Details: assessment.assessor1Details,
          assessor2Details: assessment.assessor2Details,
          confirmedGrade: assessment.confirmedGrade,
        },
      };
      const answersSnapshot = {
        scaleVersionId: assessment.scaleVersion?.id,
        rows: answers.map((a) => ({
          assessorId: a.assessorId,
          itemCode: a.itemCode,
          optionCode: a.optionCode,
          score: a.score,
          na: a.na,
        })),
      };
      const deliverySnapshot = {
        notificationId: notification.id,
        status: notification.status,
        notifiableStatus: notification.notifiableStatus,
        message: notification.message,
        deliveredAt: notification.deliveredAt,
        deliveredDate,
        attempts: notification.attempts,
        lastAttemptAt: notification.lastAttemptAt,
      };

      const appealEntity = new Appeal();
      appealEntity.assessmentCase = assessment;
      appealEntity.notification = notification;
      appealEntity.boundGradeVersionId = gradeVersion.id;
      appealEntity.boundGradeVersion = gradeVersion;
      appealEntity.familyRequester = dto.familyRequester;
      appealEntity.reason = dto.reason;
      appealEntity.status = AppealStatus.SUBMITTED;
      appealEntity.deadlineDate = deadlineDate;
      appealEntity.submittedAt = new Date(`${submittedDate}T00:00:00.000Z`);
      appealEntity.gradeSnapshot = gradeSnapshot;
      appealEntity.answersSnapshot = answersSnapshot;
      appealEntity.deliverySnapshot = deliverySnapshot;
      appealEntity.submitIdempotencyKey = dto.idempotencyKey ?? null;
      const appeal = await em.save(appealEntity);
      await this.saveMaterials(em, appeal, dto.materials, 'INITIAL');
      await this.saveEvent(em, {
        appeal,
        type: AppealEventType.SUBMITTED,
        fromStatus: null,
        toStatus: AppealStatus.SUBMITTED,
        actorId: dto.familyRequester,
        payload: { reason: dto.reason, submittedDate, deadlineDate },
        idempotencyKey: dto.idempotencyKey,
        fingerprintData: dto,
      });
      return { replayed: false, appeal: await this.findOne(em, appeal.id) };
    }).catch((e) => {
      throw this.translateCreateError(e);
    });
  }

  private translateCreateError(e: unknown) {
    if (this.isConstraintError(e, 'appeals_notification_active_idx')) {
      return new ConflictException({
        code: 'ACTIVE_APPEAL_EXISTS',
        message: '相同告知已有进行中的申诉（数据库唯一约束拦截）',
      });
    }
    if (
      this.isConstraintError(e, 'appeals_submit_idempotency_key_key') ||
      this.isConstraintError(e, 'appeal_events_idempotency_key_key')
    ) {
      return new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: '幂等键已用于不同申诉请求',
      });
    }
    return e;
  }

  private isConstraintError(e: unknown, constraint: string): boolean {
    const err = e as { constraint?: string; message?: string };
    return err?.constraint === constraint || String(err?.message ?? '').includes(constraint);
  }

  async requestCorrection(appealId: string, dto: RequestCorrectionDto) {
    this.validateOptionalDate(dto.dueDate, 'CORRECTION_DUE_DATE_INVALID');
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      if (dto.idempotencyKey) {
        const replayed = await this.findReplay(em, dto.idempotencyKey);
        if (replayed) return this.replayPayload(replayed, '重复补正请求已幂等回放');
      }
      if (appeal.status === AppealStatus.PENDING_CORRECTION) {
        return this.replayPayload(appeal, '申诉已在待补正状态，重复请求未再次迁移状态');
      }
      this.assertStatus(appeal, [AppealStatus.SUBMITTED], '只有已提交申诉可以要求补正');
      const dueDate = dto.dueDate ?? addDays(this.todayUtc(), CORRECTION_DAYS);
      if (dueDate < this.todayUtc()) throw new BadRequestException({ code: 'CORRECTION_DUE_DATE_PAST' });

      appeal.status = AppealStatus.PENDING_CORRECTION;
      appeal.correctionDueDate = dueDate;
      appeal.correctionRequestedAt = new Date();
      await em.save(appeal);
      await this.saveEvent(em, {
        appeal,
        type: AppealEventType.CORRECTION_REQUESTED,
        fromStatus: AppealStatus.SUBMITTED,
        toStatus: AppealStatus.PENDING_CORRECTION,
        actorId: dto.reviewerId,
        payload: { requestComment: dto.requestComment, dueDate },
        idempotencyKey: dto.idempotencyKey,
        fingerprintData: dto,
      });
      return { replayed: false, appeal: await this.findOne(em, appeal.id) };
    });
  }

  async supplement(appealId: string, dto: SupplementAppealDto) {
    this.validateOptionalDate(dto.submittedDate, 'SUPPLEMENT_DATE_INVALID');
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      if (dto.idempotencyKey) {
        const replayed = await this.findReplay(em, dto.idempotencyKey);
        if (replayed) return this.replayPayload(replayed, '重复补正材料已幂等回放');
      }
      const submittedDate = dto.submittedDate ?? this.todayUtc();
      if (appeal.status !== AppealStatus.PENDING_CORRECTION) {
        if (ACTIVE_STATUSES.includes(appeal.status)) {
          return this.replayPayload(appeal, '当前无需补正，重复补正请求未改变状态');
        }
        throw new ConflictException({ code: 'APPEAL_NOT_ACTIVE', message: '终态申诉不能补正' });
      }
      if (submittedDate > appeal.correctionDueDate!) {
        await this.markExpired(
          em,
          appeal,
          'system',
          `补正日期 ${submittedDate} 已超过补正期限 ${appeal.correctionDueDate}`,
          dto.idempotencyKey,
          dto,
        );
        return {
          correctionExpired: true as const,
          appeal: await this.findOne(em, appeal.id),
        };
      }

      await this.saveMaterials(em, appeal, dto.materials, 'SUPPLEMENT');
      appeal.status = AppealStatus.PENDING_RULING;
      appeal.supplementedAt = new Date(`${submittedDate}T12:00:00.000Z`);
      await em.save(appeal);
      await this.saveEvent(em, {
        appeal,
        type: AppealEventType.SUPPLEMENTED,
        fromStatus: AppealStatus.PENDING_CORRECTION,
        toStatus: AppealStatus.PENDING_RULING,
        actorId: dto.familyRequester,
        payload: { comment: dto.comment, submittedDate, materialCount: dto.materials.length },
        idempotencyKey: dto.idempotencyKey,
        fingerprintData: dto,
      });
      return { replayed: false, appeal: await this.findOne(em, appeal.id) };
    });
  }

  async withdraw(appealId: string, dto: WithdrawAppealDto) {
    this.validateOptionalDate(dto.submittedDate, 'WITHDRAW_DATE_INVALID');
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      if (dto.idempotencyKey) {
        const replayed = await this.findReplay(em, dto.idempotencyKey);
        if (replayed) return this.replayPayload(replayed, '重复撤回请求已幂等回放');
      }
      if (appeal.status === AppealStatus.WITHDRAWN) {
        return this.replayPayload(appeal, '申诉已撤回，重复撤回请求未再次生效');
      }
      this.assertStatus(
        appeal,
        [AppealStatus.SUBMITTED, AppealStatus.PENDING_CORRECTION, AppealStatus.PENDING_RULING],
        '仅进行中的申诉可以撤回',
      );
      const from = appeal.status;
      appeal.status = AppealStatus.WITHDRAWN;
      appeal.withdrawnAt = new Date(`${dto.submittedDate ?? this.todayUtc()}T12:00:00.000Z`);
      await em.save(appeal);
      await this.saveEvent(em, {
        appeal,
        type: AppealEventType.WITHDRAWN,
        fromStatus: from,
        toStatus: AppealStatus.WITHDRAWN,
        actorId: dto.familyRequester,
        payload: { reason: dto.reason, submittedDate: dto.submittedDate ?? this.todayUtc() },
        idempotencyKey: dto.idempotencyKey,
        fingerprintData: dto,
      });
      return { replayed: false, appeal: await this.findOne(em, appeal.id) };
    });
  }

  async expire(appealId: string, dto: ExpireAppealDto) {
    this.validateOptionalDate(dto.asOfDate, 'EXPIRE_DATE_INVALID');
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      if (dto.idempotencyKey) {
        const replayed = await this.findReplay(em, dto.idempotencyKey);
        if (replayed) return this.replayPayload(replayed, '重复过期请求已幂等回放');
      }
      if (appeal.status === AppealStatus.EXPIRED) {
        return this.replayPayload(appeal, '申诉已过期，重复请求未再次迁移');
      }
      this.assertStatus(
        appeal,
        [AppealStatus.SUBMITTED, AppealStatus.PENDING_CORRECTION, AppealStatus.PENDING_RULING],
        '仅进行中的申诉可以标记过期',
      );
      if (
        appeal.status !== AppealStatus.PENDING_CORRECTION &&
        (dto.asOfDate ?? this.todayUtc()) <= appeal.deadlineDate
      ) {
        throw new ConflictException({ code: 'APPEAL_NOT_EXPIRED', message: '申诉期限尚未届满' });
      }
      if (
        appeal.status === AppealStatus.PENDING_CORRECTION &&
        (dto.asOfDate ?? this.todayUtc()) <= appeal.correctionDueDate!
      ) {
        throw new ConflictException({ code: 'CORRECTION_NOT_EXPIRED', message: '补正期限尚未届满' });
      }
      await this.markExpired(em, appeal, dto.actorId, dto.reason, dto.idempotencyKey, dto);
      return { replayed: false, appeal: await this.findOne(em, appeal.id) };
    });
  }

  async rule(appealId: string, dto: RuleAppealDto) {
    this.validateOptionalDate(dto.effectiveDate, 'EFFECTIVE_DATE_INVALID');
    this.validateOptionalDate(dto.feeImpactTo, 'FEE_IMPACT_DATE_INVALID');
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      if (dto.idempotencyKey) {
        const replayed = await this.findReplay(em, dto.idempotencyKey);
        if (replayed) return this.replayPayload(replayed, '重复裁决请求已幂等回放');
      }
      if ([AppealStatus.UPHELD, AppealStatus.CHANGED].includes(appeal.status)) {
        const rulingEvent = await em.findOne(AppealEvent, {
          where: { appealId: appeal.id },
          order: { createdAt: 'DESC' },
        });
        if (
          rulingEvent &&
          rulingEvent.requestFingerprint === this.fingerprint(dto)
        ) {
          return this.replayPayload(
            appeal,
            '完全相同的裁决请求已幂等回放，未产生第二条决定或等级',
          );
        }
        throw new ConflictException({
          code: 'APPEAL_ALREADY_RULED',
          message: `申诉已裁决为 ${appeal.status}，不能重复或改写裁决`,
        });
      }
      this.assertStatus(
        appeal,
        [AppealStatus.SUBMITTED, AppealStatus.PENDING_RULING],
        '待补正/撤回/过期状态不能裁决',
      );
      const originalStatus = appeal.status;

      const assessment = await em.findOneOrFail(AssessmentCase, {
        where: { id: appeal.assessmentCase.id },
      });
      const boundGrade = appeal.boundGradeVersion;
      const outcome =
        dto.confirmedGrade === boundGrade.grade
          ? AppealRulingOutcome.UPHELD
          : AppealRulingOutcome.CHANGED;

      if (outcome === AppealRulingOutcome.CHANGED && !dto.effectiveDate) {
        throw new BadRequestException({
          code: 'EFFECTIVE_DATE_REQUIRED',
          message: '裁决变更等级必须提供明确费用生效日',
        });
      }
      const effectiveDate = dto.effectiveDate ?? null;
      if (effectiveDate && !isValidDate(effectiveDate)) {
        throw new BadRequestException({ code: 'EFFECTIVE_DATE_INVALID' });
      }
      if (effectiveDate && !isValidDate(effectiveDate)) {
        throw new BadRequestException({ code: 'EFFECTIVE_DATE_INVALID' });
      }
      if (dto.feeImpactTo && !isValidDate(dto.feeImpactTo)) {
        throw new BadRequestException({ code: 'FEE_IMPACT_DATE_INVALID' });
      }
      const impactTo = dto.feeImpactTo ?? effectiveDate;
      if (outcome === AppealRulingOutcome.CHANGED && impactTo! < effectiveDate!) {
        throw new BadRequestException({
          code: 'FEE_IMPACT_RANGE_INVALID',
          message: '费用影响结束日不得早于等级生效日',
        });
      }
      let feeBeforeAmount: string | null = null;
      let feeAfterAmount: string | null = null;
      let feeDeltaAmount: string | null = null;
      let feeImpact: any = null;
      let newVersion: GradeVersion | null = null;
      let period: any = null;

      if (outcome === AppealRulingOutcome.UPHELD) {
        appeal.status = AppealStatus.UPHELD;
        appeal.rulingOutcome = AppealRulingOutcome.UPHELD;
        appeal.ruledGrade = boundGrade.grade;
      } else {
        const beforeQuote = await this.gradePeriods.quoteGradeFee(
          em,
          boundGrade.grade,
          effectiveDate!,
          impactTo!,
        );
        const afterQuote = await this.gradePeriods.quoteGradeFee(
          em,
          dto.confirmedGrade,
          effectiveDate!,
          impactTo!,
        );
        feeBeforeAmount = beforeQuote.totalAmount;
        feeAfterAmount = afterQuote.totalAmount;
        feeDeltaAmount = new Decimal(afterQuote.totalAmount)
          .minus(beforeQuote.totalAmount)
          .toFixed(2);
        feeImpact = {
          from: effectiveDate,
          to: impactTo,
          before: beforeQuote,
          after: afterQuote,
          delta: feeDeltaAmount,
        };

        const nextNumber = await em.count(GradeVersion, {
          where: { assessmentCase: { id: assessment.id } },
        });
        const versionEntity = new GradeVersion();
        versionEntity.assessmentCase = assessment;
        versionEntity.versionNumber = nextNumber + 1;
        versionEntity.grade = dto.confirmedGrade;
        versionEntity.source = GradeVersionSource.APPEAL;
        versionEntity.sourceReviewId = null;
        versionEntity.sourceAppealId = appeal.id;
        versionEntity.effectiveDate = effectiveDate;
        versionEntity.gradePeriodId = null;
        versionEntity.basisSnapshot = {
          appealId: appeal.id,
          originalGradeVersionId: boundGrade.id,
          originalGrade: boundGrade.grade,
          outcome: AppealRulingOutcome.CHANGED,
          reviewerId: dto.reviewerId,
          comment: dto.comment,
          effectiveDate,
        };
        newVersion = await em.save(versionEntity);
        period = await this.gradePeriods.applyVersion(em, {
          elderId: assessment.elderId,
          caseId: assessment.id,
          gradeVersionId: newVersion.id,
          grade: dto.confirmedGrade,
          effectiveDate: effectiveDate!,
        });
        newVersion.gradePeriodId = period.id;
        await em.save(newVersion);

        assessment.currentGradeVersion = newVersion;
        assessment.currentGradeVersionId = newVersion.id;
        assessment.confirmedGrade = dto.confirmedGrade;
        await em.save(assessment);

        appeal.status = AppealStatus.CHANGED;
        appeal.rulingOutcome = AppealRulingOutcome.CHANGED;
        appeal.ruledGrade = dto.confirmedGrade;
        appeal.resultGradeVersion = newVersion;
        appeal.resultGradeVersionId = newVersion.id;
      }

      appeal.reviewerId = dto.reviewerId;
      appeal.rulingComment = dto.comment;
      appeal.ruledAt = new Date();
      appeal.effectiveDate = effectiveDate;
      appeal.feeBeforeAmount = feeBeforeAmount;
      appeal.feeAfterAmount = feeAfterAmount;
      appeal.feeDeltaAmount = feeDeltaAmount;
      appeal.feeImpactFrom = outcome === AppealRulingOutcome.CHANGED ? effectiveDate : null;
      appeal.feeImpactTo = outcome === AppealRulingOutcome.CHANGED ? impactTo : null;
      await em.save(appeal);

      const outcomeNotification = new NotificationRecord();
      outcomeNotification.assessmentCase = assessment;
      outcomeNotification.status = NotificationStatus.PENDING;
      outcomeNotification.notifiableStatus = NotifiableStatus.CONFIRMED;
      outcomeNotification.attempts = 0;
      outcomeNotification.failureReason = null;
      outcomeNotification.gradeVersion = newVersion ?? boundGrade;
      outcomeNotification.gradeVersionId = newVersion?.id ?? boundGrade.id;
      outcomeNotification.message =
        outcome === AppealRulingOutcome.UPHELD
          ? `申诉裁决通知：经 ${dto.reviewerId} 裁决，维持 ${boundGrade.grade}。${dto.comment}`
          : `申诉裁决通知：经 ${dto.reviewerId} 裁决，等级变更为 ${dto.confirmedGrade}，自 ${effectiveDate} 起按新等级计费。${dto.comment}`;
      await em.save(outcomeNotification);

      await this.saveEvent(em, {
        appeal,
        type:
          outcome === AppealRulingOutcome.UPHELD
            ? AppealEventType.RULED_UPHELD
            : AppealEventType.RULED_CHANGED,
        fromStatus: originalStatus,
        toStatus:
          outcome === AppealRulingOutcome.UPHELD
            ? AppealStatus.UPHELD
            : AppealStatus.CHANGED,
        actorId: dto.reviewerId,
        payload: {
          outcome,
          boundGrade: boundGrade.grade,
          confirmedGrade: dto.confirmedGrade,
          comment: dto.comment,
          effectiveDate,
          feeImpact,
          periodId: period?.id ?? null,
          outcomeNotificationId: outcomeNotification.id,
        },
        idempotencyKey: dto.idempotencyKey,
        fingerprintData: dto,
      });

      const saved = await this.findOne(em, appeal.id);
      return { replayed: false, feeImpact, period, appeal: saved };
    });
  }

  async get(appealId: string) {
    const appeal = await this.findOne(this.dataSource.manager, appealId);
    if (!appeal) throw new NotFoundException('申诉不存在');
    return appeal;
  }

  async listForCase(caseId: string) {
    const rows = await this.appealRepo.find({
      where: { assessmentCase: { id: caseId } },
      relations: {
        notification: true,
        boundGradeVersion: true,
        resultGradeVersion: true,
        materials: true,
        events: true,
      },
      order: { createdAt: 'ASC', events: { createdAt: 'ASC' }, materials: { sequence: 'ASC' } },
    });
    return rows;
  }

  async feeImpact(appealId: string, from?: string, to?: string) {
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      if (appeal.status !== AppealStatus.CHANGED || !appeal.resultGradeVersionId || !appeal.effectiveDate) {
        throw new ConflictException({ code: 'NO_CHANGED_FEE_IMPACT', message: '仅变更裁决存在费用影响' });
      }
      const start = from ?? appeal.effectiveDate;
      const end = to ?? appeal.feeImpactTo ?? appeal.effectiveDate;
      if (!isValidDate(start) || !isValidDate(end) || start < appeal.effectiveDate || end < start) {
        throw new BadRequestException({ code: 'INVALID_FEE_IMPACT_RANGE' });
      }
      const oldGrade = (appeal.gradeSnapshot as any).grade;
      const newGrade = appeal.ruledGrade;
      const before = await this.gradePeriods.quoteGradeFee(em, oldGrade, start, end);
      const after = await this.gradePeriods.quoteGradeFee(em, newGrade!, start, end);
      return {
        appealId: appeal.id,
        from: start,
        to: end,
        effectiveDate: appeal.effectiveDate,
        beforeGrade: oldGrade,
        afterGrade: newGrade,
        before: before,
        after: after,
        delta: new Decimal(after.totalAmount).minus(before.totalAmount).toFixed(2),
      };
    });
  }

  private async markExpired(
    em: EntityManager,
    appeal: Appeal,
    actorId: string,
    reason: string | undefined,
    idempotencyKey: string | undefined,
    fingerprintData: unknown,
  ) {
    const from = appeal.status;
    appeal.status = AppealStatus.EXPIRED;
    appeal.expiredAt = new Date();
    await em.save(appeal);
    await this.saveEvent(em, {
      appeal,
      type: AppealEventType.EXPIRED,
      fromStatus: from,
      toStatus: AppealStatus.EXPIRED,
      actorId,
      payload: { reason: reason ?? '申诉/补正超过规定期限' },
      idempotencyKey,
      fingerprintData,
    });
  }

  private async lockCase(em: EntityManager, caseId: string) {
    const rows = await em.query(
      `SELECT * FROM assessment_cases WHERE id = $1 FOR UPDATE`,
      [caseId],
    );
    if (!rows.length) throw new NotFoundException('评估案件不存在');
    return em.findOneOrFail(AssessmentCase, {
      where: { id: caseId },
      relations: { scaleVersion: true },
    });
  }

  private async lockNotification(em: EntityManager, id: string) {
    await em.query(`SELECT id FROM notification_records WHERE id = $1 FOR UPDATE`, [id]);
  }

  private async lockAppeal(em: EntityManager, id: string): Promise<Appeal> {
    const rows = await em.query(`SELECT id FROM appeals WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows.length) throw new NotFoundException('申诉不存在');
    const appeal = await em.findOne(Appeal, { where: { id } });
    if (!appeal) throw new NotFoundException('申诉不存在');
    // QueryBuilder with relation needed because plain find won't hydrate relation ids on locked object
    return em.findOneOrFail(Appeal, {
      where: { id },
      relations: { assessmentCase: true, boundGradeVersion: true },
    });
  }

  private assertStatus(appeal: Appeal, allowed: AppealStatus[], message: string) {
    if (!allowed.includes(appeal.status)) {
      throw new ConflictException({
        code: 'INVALID_APPEAL_TRANSITION',
        message: `${message}；当前状态 ${appeal.status}`,
        currentStatus: appeal.status,
        allowedStatuses: allowed,
      });
    }
  }

  private async findReplay(em: EntityManager, key: string): Promise<Appeal | null> {
    const event = await em.findOne(AppealEvent, { where: { idempotencyKey: key } });
    if (event) return em.findOneOrFail(Appeal, { where: { id: event.appealId } });
    const appeal = await em.findOne(Appeal, { where: { submitIdempotencyKey: key } });
    return appeal;
  }

  private async replayPayload(appeal: Appeal, message: string): Promise<Replay<Appeal>> {
    return {
      replayed: true,
      message,
      appeal: await this.findOne(this.dataSource.manager, appeal.id),
    };
  }

  private async saveMaterials(
    em: EntityManager,
    appeal: Appeal,
    materials: CreateAppealDto['materials'] | SupplementAppealDto['materials'],
    kind: 'INITIAL' | 'SUPPLEMENT',
  ) {
    const count = await em.count(AppealMaterial, { where: { appealId: appeal.id } });
    let seq = count;
    for (const m of materials) {
      seq += 1;
      await em.save(AppealMaterial, {
        appeal,
        appealId: appeal.id,
        sequence: seq,
        kind,
        fileName: m.fileName,
        fileRef: m.fileRef,
        note: m.note ?? null,
      });
    }
  }

  private async saveEvent(
    em: EntityManager,
    args: {
      appeal: Appeal;
      type: AppealEventType;
      fromStatus: string | null;
      toStatus: string | null;
      actorId: string;
      payload: unknown;
      idempotencyKey?: string;
      fingerprintData?: unknown;
    },
  ) {
    await em.save(AppealEvent, {
      appeal: args.appeal,
      appealId: args.appeal.id,
      eventType: args.type,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      actorId: args.actorId,
      payload: args.payload,
      idempotencyKey: args.idempotencyKey ?? null,
      requestFingerprint: args.fingerprintData
        ? this.fingerprint(args.fingerprintData)
        : null,
    });
  }

  private async findOne(em: EntityManager, id: string): Promise<Appeal> {
    return em.findOneOrFail(Appeal, {
      where: { id },
      relations: {
        assessmentCase: true,
        notification: true,
        boundGradeVersion: true,
        resultGradeVersion: true,
        materials: true,
        events: true,
      },
      order: {
        materials: { sequence: 'ASC' },
        events: { createdAt: 'ASC' },
      },
    });
  }

  private fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private validateOptionalDate(value: string | undefined, code: string) {
    if (value && !isValidDate(value)) {
      throw new BadRequestException({ code, message: `日期 ${value} 不合法` });
    }
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private dateInUtc(d: Date): string {
    return new Date(d).toISOString().slice(0, 10);
  }
}
