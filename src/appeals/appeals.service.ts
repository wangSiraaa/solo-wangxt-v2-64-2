import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Appeal } from '../entities/appeal.entity';
import { AppealEvent } from '../entities/appeal-event.entity';
import { AppealDecision } from '../entities/appeal-decision.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import {
  AppealDecisionValue,
  AppealEventAction,
  AppealStatus,
  NotifiableStatus,
  NotificationStatus,
} from '../common/enums';
import { addDays, isValidDate } from '../common/date.util';
import { moneyText } from '../common/money.util';
import { FeesService } from '../fees/fees.service';
import { GradePeriodsService } from '../fees/grade-periods.service';
import {
  AdjudicateAppealDto,
  FileAppealDto,
  SupplementAppealDto,
  WithdrawAppealDto,
} from './dto/appeal.dto';

/** 进行中（非终态）状态 */
const OPEN_STATUSES: AppealStatus[] = [
  AppealStatus.SUBMITTED,
  AppealStatus.PENDING_CORRECTION,
  AppealStatus.PENDING_ADJUDICATION,
];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function asDateString(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

@Injectable()
export class AppealsService {
  constructor(
    @InjectRepository(Appeal)
    private readonly appealRepo: Repository<Appeal>,
    @InjectRepository(AppealEvent)
    private readonly eventRepo: Repository<AppealEvent>,
    @InjectRepository(AppealDecision)
    private readonly decisionRepo: Repository<AppealDecision>,
    @InjectRepository(NotificationRecord)
    private readonly notifRepo: Repository<NotificationRecord>,
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    private readonly fees: FeesService,
    private readonly gradePeriods: GradePeriodsService,
    private readonly dataSource: DataSource,
  ) {}

  private get appealWindowDays(): number {
    return Number(process.env.APPEAL_WINDOW_DAYS ?? 30);
  }

  private get correctionWindowDays(): number {
    return Number(process.env.APPEAL_CORRECTION_DAYS ?? 15);
  }

  private get impactHorizonDays(): number {
    return Number(process.env.APPEAL_IMPACT_HORIZON_DAYS ?? 30);
  }

  /**
   * 申诉受理。前提（不满足则 409 拒绝且不产生任何数据、不污染评估）：
   *  - 告知记录存在且已送达（DELIVERED）；送达失败/未送达不受理；
   *  - 申诉日在受理期限内（送达日 + APPEAL_WINDOW_DAYS，默认 30 天）。
   * 受理即固化快照：当时的确认等级、两位评估员量表答案、送达记录、复核意见。
   * 同一告知只能有一条进行中的申诉（部分唯一索引原子保证）。
   */
  async file(dto: FileAppealDto) {
    const notification = await this.notifRepo.findOne({
      where: { id: dto.notificationId },
      relations: { assessmentCase: true },
    });
    if (!notification) throw new NotFoundException('告知记录不存在');

    const assessmentCase = await this.caseRepo.findOne({
      where: { id: notification.assessmentCase.id },
      relations: { review: true, answers: true, scaleVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    // 幂等回放：相同幂等键直接返回首次受理结果
    if (dto.idempotencyKey) {
      const existing = await this.appealRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return {
          replayed: true,
          message: '重复申诉请求已幂等回放，未产生第二条申诉',
          appeal: await this.findOne(existing.id),
        };
      }
    }

    if (notification.status !== NotificationStatus.DELIVERED) {
      throw new ConflictException({
        code: 'APPEAL_NOTIFICATION_NOT_DELIVERED',
        message: `告知尚未送达（当前状态 ${notification.status}），家属未有效收到等级告知，申诉不予受理`,
      });
    }
    if (!assessmentCase.confirmedGrade) {
      throw new ConflictException({
        code: 'APPEAL_GRADE_NOT_CONFIRMED',
        message: '等级尚未确认，无可异议的确认等级',
      });
    }

    const filedOn = dto.filedOn ?? todayUtc();
    if (!isValidDate(filedOn)) {
      throw new BadRequestException({
        code: 'INVALID_FILED_ON',
        message: `申诉日期 ${filedOn} 不是合法公历日期`,
      });
    }
    const deliveredOn = asDateString(notification.lastAttemptAt ?? notification.createdAt);
    const appealDeadline = addDays(deliveredOn, this.appealWindowDays);
    if (filedOn < deliveredOn) {
      throw new BadRequestException({
        code: 'FILED_BEFORE_DELIVERY',
        message: `申诉日期 ${filedOn} 早于告知送达日 ${deliveredOn}`,
      });
    }
    if (filedOn > appealDeadline) {
      throw new ConflictException({
        code: 'APPEAL_WINDOW_EXPIRED',
        message: `申诉期限已过（送达日 ${deliveredOn}，受理期限 ${appealDeadline}，申诉日 ${filedOn}），不予受理`,
      });
    }

    // 相同告知只能有一个进行中的申诉（服务层预检 + 部分唯一索引兜底）
    const openExisting = await this.appealRepo.findOne({
      where: OPEN_STATUSES.map((status) => ({
        notificationId: notification.id,
        status,
      })),
    });
    if (openExisting) {
      throw new ConflictException({
        code: 'APPEAL_ALREADY_OPEN',
        message: `该告知已存在进行中的申诉（${openExisting.id}，状态 ${openExisting.status}），不得重复申诉`,
        appealId: openExisting.id,
      });
    }

    const materials = dto.materials ?? [];
    const initialStatus = materials.length
      ? AppealStatus.SUBMITTED
      : AppealStatus.PENDING_CORRECTION;
    const correctionDeadline =
      dto.correctionDeadline ?? addDays(filedOn, this.correctionWindowDays);
    if (!isValidDate(correctionDeadline)) {
      throw new BadRequestException({
        code: 'INVALID_CORRECTION_DEADLINE',
        message: `补正期限 ${correctionDeadline} 不是合法公历日期`,
      });
    }

    // 快照：当时的确认等级 / 量表答案 / 送达记录 / 复核意见
    const snapshotAnswers = assessmentCase.answers
      .map((a) => ({
        assessorId: a.assessorId,
        itemCode: a.itemCode,
        optionCode: a.optionCode,
        score: a.score,
        na: a.na,
      }))
      .sort((a, b) =>
        a.assessorId === b.assessorId
          ? a.itemCode.localeCompare(b.itemCode)
          : a.assessorId - b.assessorId,
      );
    const snapshotDelivery = {
      notificationId: notification.id,
      status: notification.status,
      notifiableStatus: notification.notifiableStatus,
      message: notification.message,
      attempts: notification.attempts,
      lastAttemptAt: notification.lastAttemptAt,
      createdAt: notification.createdAt,
    };
    const snapshotReview = assessmentCase.review
      ? {
          result: assessmentCase.review.result,
          confirmedGrade: assessmentCase.review.confirmedGrade,
          reviewerId: assessmentCase.review.reviewerId,
          comment: assessmentCase.review.comment,
          decidedAt: assessmentCase.review.decidedAt,
        }
      : null;

    try {
      const appealId = await this.dataSource.transaction(async (em) => {
        const appeal = new Appeal();
        appeal.notificationId = notification.id;
        appeal.assessmentCaseId = assessmentCase.id;
        appeal.elderId = assessmentCase.elderId;
        appeal.status = initialStatus;
        appeal.reason = dto.reason;
        appeal.filedBy = dto.filedBy;
        appeal.filedOn = filedOn;
        appeal.materials = materials;
        appeal.snapshotGrade = assessmentCase.confirmedGrade!;
        appeal.snapshotAnswers = snapshotAnswers;
        appeal.snapshotDelivery = snapshotDelivery;
        appeal.snapshotReview = snapshotReview;
        appeal.appealDeadline = appealDeadline;
        appeal.correctionDeadline = correctionDeadline;
        appeal.idempotencyKey = dto.idempotencyKey ?? null;
        const saved = await em.save(appeal);

        await em.save(this.buildEvent(saved.id, AppealEventAction.FILED, dto.filedBy, {
          note: materials.length
            ? '申诉受理：材料齐全，待裁决'
            : '申诉受理：材料不足，待补正',
          payload: {
            reason: dto.reason,
            materials,
            snapshotGrade: saved.snapshotGrade,
            appealDeadline,
            correctionDeadline,
          },
          idempotencyKey: dto.idempotencyKey ?? null,
        }));
        return saved.id;
      });
      return { replayed: false, appeal: await this.findOne(appealId) };
    } catch (e: any) {
      if (this.isConstraint(e, 'appeals_one_open_per_notification')) {
        throw new ConflictException({
          code: 'APPEAL_ALREADY_OPEN',
          message: '该告知已存在进行中的申诉（并发请求，数据库唯一约束拦截）',
        });
      }
      if (this.isConstraint(e, 'appeals_idempotency_key_key') && dto.idempotencyKey) {
        const existing = await this.appealRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existing) {
          return {
            replayed: true,
            message: '并发重复申诉请求已幂等回放',
            appeal: await this.findOne(existing.id),
          };
        }
      }
      throw e;
    }
  }

  /**
   * 补正：家属补充材料。SUBMITTED / PENDING_CORRECTION → PENDING_ADJUDICATION。
   * 重复（同幂等键）回放；乱序（终态后到达）409；待补正超期先落 EXPIRED 再拒绝。
   */
  async supplement(appealId: string, dto: SupplementAppealDto) {
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      await this.expireIfOverdue(em, appeal);

      if (!OPEN_STATUSES.includes(appeal.status)) {
        throw this.closedConflict(appeal, '补正');
      }
      const replay = await this.findEventReplay(em, appeal.id, AppealEventAction.SUPPLEMENTED, dto.idempotencyKey);
      if (replay) return { replayed: true, appeal: await this.loadDetail(em, appeal.id) };
      await this.assertKeyFree(em, appeal.id, dto.idempotencyKey);

      appeal.materials = [...appeal.materials, ...dto.materials];
      appeal.status = AppealStatus.PENDING_ADJUDICATION;
      await em.save(appeal);
      await em.save(
        this.buildEvent(appeal.id, AppealEventAction.SUPPLEMENTED, appeal.filedBy, {
          note: dto.note ?? '家属补正材料，材料齐备，待裁决',
          payload: { addedMaterials: dto.materials },
          idempotencyKey: dto.idempotencyKey ?? null,
        }),
      );
      return { replayed: false, appeal: await this.loadDetail(em, appeal.id) };
    }).catch(async (e: any) => {
      if (this.isConstraint(e, 'appeal_events_appeal_idempotency_key') && dto.idempotencyKey) {
        return { replayed: true, appeal: await this.findOne(appealId) };
      }
      throw e;
    });
  }

  /**
   * 撤回：进行中 → WITHDRAWN。撤回本身是幂等的（重复撤回回放当前状态）；
   * 已裁决/已过期的申诉不得撤回。撤回后迟到的裁决不得生效（见 adjudicate）。
   */
  async withdraw(appealId: string, dto: WithdrawAppealDto) {
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, appealId);
      await this.expireIfOverdue(em, appeal);

      if (appeal.status === AppealStatus.WITHDRAWN) {
        return { replayed: true, message: '申诉已撤回，重复撤回请求幂等回放', appeal: await this.loadDetail(em, appeal.id) };
      }
      if (!OPEN_STATUSES.includes(appeal.status)) {
        throw this.closedConflict(appeal, '撤回');
      }
      const replay = await this.findEventReplay(em, appeal.id, AppealEventAction.WITHDRAWN, dto.idempotencyKey);
      if (replay) return { replayed: true, appeal: await this.loadDetail(em, appeal.id) };
      await this.assertKeyFree(em, appeal.id, dto.idempotencyKey);

      appeal.status = AppealStatus.WITHDRAWN;
      appeal.closedAt = new Date();
      await em.save(appeal);
      await em.save(
        this.buildEvent(appeal.id, AppealEventAction.WITHDRAWN, dto.withdrawnBy, {
          note: dto.reason ?? '家属主动撤回申诉',
          idempotencyKey: dto.idempotencyKey ?? null,
        }),
      );
      return { replayed: false, appeal: await this.loadDetail(em, appeal.id) };
    }).catch(async (e: any) => {
      if (this.isConstraint(e, 'appeal_events_appeal_idempotency_key') && dto.idempotencyKey) {
        return { replayed: true, appeal: await this.findOne(appealId) };
      }
      throw e;
    });
  }

  /**
   * 裁决（管理员）。仅 SUBMITTED / PENDING_ADJUDICATION 可裁决：
   *  - UPHELD 维持：不改写原复核意见、不动等级期间，费用影响为零；
   *  - CHANGED 变更：追加新等级版本（grade_periods 新行，旧期间截断），
   *    按明确生效日在同一事务内计算前后费用差异并快照到裁决决定；
   *    原复核意见（review_decisions）保持不变。
   * 并发裁决：申诉行 FOR UPDATE 串行化 + appeal_decisions.appeal_id 唯一约束，
   * 仅一个成功；等级期间另有 gist 排他约束兜底，绝不产生两条有效等级。
   */
  async adjudicate(appealId: string, dto: AdjudicateAppealDto) {
    if (dto.decision === AppealDecisionValue.CHANGED) {
      if (!dto.newGrade || !dto.effectiveDate) {
        throw new BadRequestException({
          code: 'CHANGED_REQUIRES_GRADE_AND_DATE',
          message: '变更裁决必须给出新等级 newGrade 与明确生效日 effectiveDate',
        });
      }
      if (!isValidDate(dto.effectiveDate)) {
        throw new BadRequestException({
          code: 'INVALID_EFFECTIVE_DATE',
          message: `生效日 ${dto.effectiveDate} 不是合法公历日期`,
        });
      }
    } else if (dto.newGrade || dto.effectiveDate) {
      throw new BadRequestException({
        code: 'UPHELD_TAKES_NO_GRADE',
        message: '维持裁决不得携带新等级或生效日',
      });
    }

    try {
      return await this.dataSource.transaction(async (em) => {
        const appeal = await this.lockAppeal(em, appealId);
        await this.expireIfOverdue(em, appeal);

        // 已裁决：同键回放，异键/无键 409（并发裁决仅一个成功）
        if (
          appeal.status === AppealStatus.UPHELD ||
          appeal.status === AppealStatus.CHANGED
        ) {
          const decision = await em.findOne(AppealDecision, {
            where: { appealId: appeal.id },
          });
          if (
            dto.idempotencyKey &&
            decision?.idempotencyKey === dto.idempotencyKey
          ) {
            return {
              replayed: true,
              message: '重复裁决请求已幂等回放，未产生第二次裁决',
              appeal: await this.loadDetail(em, appeal.id),
              decision,
            };
          }
          throw new ConflictException({
            code: 'APPEAL_ALREADY_ADJUDICATED',
            message: `申诉已裁决（${appeal.status}），不得重复裁决`,
          });
        }
        if (appeal.status === AppealStatus.WITHDRAWN) {
          throw new ConflictException({
            code: 'APPEAL_ALREADY_WITHDRAWN',
            message: '申诉已撤回，迟到的裁决不得生效',
          });
        }
        if (appeal.status === AppealStatus.EXPIRED) {
          throw new ConflictException({
            code: 'APPEAL_EXPIRED',
            message: '申诉已过补正期限仍未补齐材料，已过期，不得裁决',
          });
        }
        if (appeal.status === AppealStatus.PENDING_CORRECTION) {
          throw new ConflictException({
            code: 'APPEAL_AWAITING_CORRECTION',
            message: '申诉材料待补正，补齐后方可裁决',
          });
        }
        await this.assertKeyFree(em, appeal.id, dto.idempotencyKey);

        const assessmentCase = await em.findOne(AssessmentCase, {
          where: { id: appeal.assessmentCaseId },
          relations: { scaleVersion: true },
        });
        if (!assessmentCase) throw new NotFoundException('评估案件不存在');

        const decision = new AppealDecision();
        decision.appealId = appeal.id;
        decision.decision = dto.decision;
        decision.adjudicatorId = dto.adjudicatorId;
        decision.comment = dto.comment;
        decision.originalGrade = appeal.snapshotGrade;
        decision.idempotencyKey = dto.idempotencyKey ?? null;

        let notificationMessage: string;
        if (dto.decision === AppealDecisionValue.UPHELD) {
          decision.newGrade = null;
          decision.effectiveDate = null;
          decision.gradePeriodId = null;
          decision.feeImpact = {
            unchanged: true,
            difference: moneyText(0),
            note: '维持原确认等级，等级期间不变，无费用影响',
          };
          appeal.status = AppealStatus.UPHELD;
          notificationMessage =
            `申诉裁决告知：${assessmentCase.elderName} 的评估等级异议经裁决维持原等级 ` +
            `${appeal.snapshotGrade}。裁决意见：${dto.comment} ` +
            `本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`;
        } else {
          if (dto.newGrade === appeal.snapshotGrade) {
            throw new BadRequestException({
              code: 'APPEAL_GRADE_UNCHANGED',
              message: `新等级与被异议等级 ${appeal.snapshotGrade} 相同，请使用维持（UPHELD）裁决`,
            });
          }
          const effectiveDate = dto.effectiveDate!;

          // 费用影响窗口：自生效日起，至被截断旧期间的最后生效日；
          // 旧期间为开放区间时取演示比较窗口（默认 30 天）
          const periodsBefore = await this.gradePeriods.lockPeriods(
            em,
            appeal.elderId,
          );
          const containing = periodsBefore.find(
            (p) =>
              p.start_date <= effectiveDate &&
              effectiveDate < (p.end_date_exclusive ?? '9999-12-31'),
          );
          const windowEnd = containing?.end_date_exclusive
            ? addDays(containing.end_date_exclusive, -1)
            : addDays(effectiveDate, this.impactHorizonDays - 1);

          // 变更前费用（同一事务内，基于既有等级期间）
          const before = await this.fees.feeSegments(
            appeal.elderId,
            effectiveDate,
            windowEnd,
            em,
          );

          // 追加新等级版本（旧期间自动截断；重叠由服务层 + gist 约束拦截）
          const appended = await this.gradePeriods.appendPeriod(em, {
            elderId: appeal.elderId,
            grade: dto.newGrade!,
            effectiveDate,
            sourceCaseId: appeal.assessmentCaseId,
            sourceAppealId: appeal.id,
          });

          // 变更后费用（同事务可见新期间）
          const after = await this.fees.feeSegments(
            appeal.elderId,
            effectiveDate,
            windowEnd,
            em,
          );

          decision.newGrade = dto.newGrade!;
          decision.effectiveDate = effectiveDate;
          decision.gradePeriodId = appended.period.id;
          decision.feeImpact = {
            windowStart: effectiveDate,
            windowEnd,
            days: before.totalDays,
            before: { totalAmount: before.totalAmount, segments: before.segments },
            after: { totalAmount: after.totalAmount, segments: after.segments },
            difference: moneyText(
              new Decimal(after.totalAmount).minus(before.totalAmount),
            ),
            note: containing?.end_date_exclusive
              ? `比较窗口为被截断旧期间的剩余区间（${effectiveDate} ~ ${windowEnd}）`
              : `旧期间为开放区间，比较窗口取生效日起 ${this.impactHorizonDays} 天演示窗口`,
          };
          appeal.status = AppealStatus.CHANGED;

          // 当前确认等级更新为新等级；原复核意见（review_decisions）不改写
          assessmentCase.confirmedGrade = dto.newGrade!;
          await em.save(assessmentCase);

          notificationMessage =
            `申诉裁决告知：${assessmentCase.elderName} 的评估等级异议经裁决变更，` +
            `由 ${appeal.snapshotGrade} 调整为 ${dto.newGrade}，自 ${effectiveDate} 起生效。` +
            `裁决意见：${dto.comment} ` +
            `本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`;
        }

        appeal.closedAt = new Date();
        await em.save(appeal);
        const savedDecision = await em.save(decision);
        await em.save(
          this.buildEvent(appeal.id, AppealEventAction.ADJUDICATED, dto.adjudicatorId, {
            note:
              dto.decision === AppealDecisionValue.UPHELD
                ? `裁决维持原等级 ${appeal.snapshotGrade}`
                : `裁决变更：${appeal.snapshotGrade} → ${dto.newGrade}，自 ${dto.effectiveDate} 生效`,
            payload: {
              decision: dto.decision,
              comment: dto.comment,
              newGrade: decision.newGrade,
              effectiveDate: decision.effectiveDate,
              feeImpact: decision.feeImpact,
            },
            idempotencyKey: dto.idempotencyKey ?? null,
          }),
        );

        // 裁决结果生成新的家属告知记录（告知链追加，既有告知不改动）
        const notification = new NotificationRecord();
        notification.assessmentCase = assessmentCase;
        notification.status = NotificationStatus.PENDING;
        notification.notifiableStatus = NotifiableStatus.CONFIRMED;
        notification.message = notificationMessage;
        notification.attempts = 0;
        notification.failureReason = null;
        await em.save(notification);

        return {
          replayed: false,
          appeal: await this.loadDetail(em, appeal.id),
          decision: savedDecision,
        };
      });
    } catch (e: any) {
      // 并发裁决：唯一约束兜底（行锁之外的第二道防线）
      if (
        e?.code === '23505' &&
        /appeal_decisions/.test(String(e?.constraint ?? '') + String(e?.detail ?? ''))
      ) {
        const decision = await this.decisionRepo.findOne({
          where: { appealId },
        });
        if (decision && decision.idempotencyKey === (dto.idempotencyKey ?? null)) {
          return {
            replayed: true,
            message: '并发重复裁决请求已幂等回放',
            appeal: await this.findOne(appealId),
            decision,
          };
        }
        throw new ConflictException({
          code: 'APPEAL_ALREADY_ADJUDICATED',
          message: '申诉已被并发裁决（数据库唯一约束拦截），仅一个裁决生效',
        });
      }
      throw e;
    }
  }

  /** 申诉详情：状态、快照、材料、裁决决定与完整留痕事件（含惰性过期判定） */
  async findOne(id: string) {
    return this.dataSource.transaction(async (em) => {
      const appeal = await this.lockAppeal(em, id);
      await this.expireIfOverdue(em, appeal);
      return this.loadDetail(em, id);
    });
  }

  /** 案件维度的申诉历史（含决定与事件链） */
  async listForCase(caseId: string) {
    const appeals = await this.appealRepo.find({
      where: { assessmentCaseId: caseId },
      relations: { events: true, decision: true },
      order: { createdAt: 'ASC', events: { createdAt: 'ASC' } },
    });
    return appeals;
  }

  // ---------------------------------------------------------------------------

  /** 行锁读取申诉（不存在 404）；所有写操作与详情读取的统一入口 */
  private async lockAppeal(em: EntityManager, id: string): Promise<Appeal> {
    const appeal = await em.findOne(Appeal, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!appeal) throw new NotFoundException('申诉不存在');
    return appeal;
  }

  /** 待补正超过补正期限：惰性落 EXPIRED 并留痕（事务内、行已锁） */
  private async expireIfOverdue(em: EntityManager, appeal: Appeal): Promise<void> {
    if (
      appeal.status === AppealStatus.PENDING_CORRECTION &&
      appeal.correctionDeadline &&
      todayUtc() > appeal.correctionDeadline
    ) {
      appeal.status = AppealStatus.EXPIRED;
      appeal.closedAt = new Date();
      await em.save(appeal);
      await em.save(
        this.buildEvent(appeal.id, AppealEventAction.EXPIRED, 'SYSTEM', {
          note: `补正期限 ${appeal.correctionDeadline} 已过仍未补齐材料，申诉过期`,
        }),
      );
    }
  }

  private async loadDetail(em: EntityManager, id: string) {
    return em.findOne(Appeal, {
      where: { id },
      relations: { events: true, decision: true },
      order: { events: { createdAt: 'ASC' } },
    });
  }

  private buildEvent(
    appealId: string,
    action: AppealEventAction,
    actor: string,
    opts: { note?: string; payload?: unknown; idempotencyKey?: string | null } = {},
  ): AppealEvent {
    const event = new AppealEvent();
    event.appealId = appealId;
    event.action = action;
    event.actor = actor;
    event.note = opts.note ?? null;
    event.payload = opts.payload ?? null;
    event.idempotencyKey = opts.idempotencyKey ?? null;
    return event;
  }

  /** 同动作同幂等键 → 回放 */
  private async findEventReplay(
    em: EntityManager,
    appealId: string,
    action: AppealEventAction,
    idempotencyKey?: string,
  ): Promise<AppealEvent | null> {
    if (!idempotencyKey) return null;
    return em.findOne(AppealEvent, {
      where: { appealId, action, idempotencyKey },
    });
  }

  /** 同一申诉内幂等键被其他动作占用 → 409 */
  private async assertKeyFree(
    em: EntityManager,
    appealId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!idempotencyKey) return;
    const used = await em.findOne(AppealEvent, {
      where: { appealId, idempotencyKey },
    });
    if (used) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: `幂等键 ${idempotencyKey} 已用于本申诉的 ${used.action} 事件，不得复用`,
      });
    }
  }

  private closedConflict(appeal: Appeal, op: string): ConflictException {
    return new ConflictException({
      code:
        appeal.status === AppealStatus.EXPIRED
          ? 'APPEAL_EXPIRED'
          : 'APPEAL_ALREADY_CLOSED',
      message: `申诉已终态（${appeal.status}），${op}请求不予受理`,
    });
  }

  private isConstraint(e: any, name: string): boolean {
    return (
      e?.code === '23505' &&
      (String(e?.constraint ?? '').includes(name) ||
        String(e?.detail ?? '').includes(name))
    );
  }
}
