import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { GradeVersion } from '../entities/grade-version.entity';
import {
  CaseStatus,
  GradeVersionSource,
  NotifiableStatus,
  NotificationStatus,
  ReviewResult,
} from '../common/enums';
import { ConfirmReviewDto } from './dto/confirm-review.dto';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(ReviewDecision)
    private readonly reviewRepo: Repository<ReviewDecision>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 管理复核确认。冲突案件不会自动取较高等级：
   * 管理员必须在两位评估员的候选等级中显式选择，并留下复核意见。
   * 重复确认请求：带相同幂等键 → 回放首次结果；不带/不同键 → 409。
   */
  async confirm(caseId: string, dto: ConfirmReviewDto) {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { review: true, notifications: true, scaleVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    if (assessmentCase.status === CaseStatus.CONFIRMED) {
      if (
        dto.idempotencyKey &&
        assessmentCase.review?.idempotencyKey === dto.idempotencyKey
      ) {
        return {
          replayed: true,
          message: '重复确认请求已幂等回放，未产生第二次确认',
          case: await this.caseRepo.findOne({
            where: { id: caseId },
            relations: { review: true, notifications: true },
          }),
        };
      }
      throw new ConflictException({
        code: 'CASE_ALREADY_CONFIRMED',
        message: `案件已确认为 ${assessmentCase.confirmedGrade}，不得重复确认`,
      });
    }

    if (assessmentCase.status === CaseStatus.INCOMPLETE) {
      throw new ConflictException({
        code: 'CASE_NOT_GRADEABLE',
        message: '必填项缺失，未自动定级；请先补充评估后再复核',
      });
    }

    // PENDING_REVIEW：最终等级必须是两位评估员候选之一
    const candidates = [
      assessmentCase.assessor1Grade,
      assessmentCase.assessor2Grade,
    ];
    if (!candidates.includes(dto.confirmedGrade)) {
      throw new BadRequestException({
        code: 'GRADE_NOT_IN_CANDIDATES',
        message: `复核等级必须取自两位评估员结果 ${candidates.join('/')}，不得另行指定或自动取高`,
      });
    }

    try {
      await this.dataSource.transaction(async (em) => {
        assessmentCase.status = CaseStatus.CONFIRMED;
        assessmentCase.confirmedGrade = dto.confirmedGrade;
        await em.save(assessmentCase);

        const review = new ReviewDecision();
        review.assessmentCase = assessmentCase;
        review.result = ReviewResult.CONFIRMED;
        review.confirmedGrade = dto.confirmedGrade;
        review.reviewerId = dto.reviewerId;
        review.comment = dto.comment;
        review.idempotencyKey = dto.idempotencyKey ?? null;
        await em.save(review);

        const savedReview = await em.findOneOrFail(ReviewDecision, {
          where: { assessmentCase: { id: caseId } },
        });
        // 实体入栈时 review 为 null；再次保存案件前显式回填，避免双向 OneToOne
        // 被身份映射中的 null 覆盖，导致复核意见外键丢失。
        assessmentCase.review = savedReview;
        const gradeVersion = await em.save(GradeVersion, {
          assessmentCase,
          versionNumber: 1,
          grade: dto.confirmedGrade,
          source: GradeVersionSource.REVIEW,
          sourceReviewId: savedReview.id,
          sourceAppealId: null,
          effectiveDate: null,
          gradePeriodId: null,
          basisSnapshot: {
            reviewId: savedReview.id,
            result: ReviewResult.CONFIRMED,
            reviewerId: dto.reviewerId,
            comment: dto.comment,
            decidedAt: savedReview.decidedAt,
          },
        });
        assessmentCase.currentGradeVersion = gradeVersion;
        assessmentCase.currentGradeVersionId = gradeVersion.id;
        await em.save(assessmentCase);

        // 等级确认后生成告知记录（尚未送达）
        const notification = new NotificationRecord();
        notification.assessmentCase = assessmentCase;
        notification.status = NotificationStatus.PENDING;
        notification.notifiableStatus = NotifiableStatus.CONFIRMED;
        notification.message =
          `家属告知：${assessmentCase.elderName} 的` +
          `${assessmentCase.scaleVersion.title}评估等级经管理复核确认为 ` +
          `${dto.confirmedGrade}。复核意见：${dto.comment} ` +
          `本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`;
        notification.attempts = 0;
        notification.failureReason = null;
        notification.gradeVersion = gradeVersion;
        notification.gradeVersionId = gradeVersion.id;
        await em.save(notification);

      });
      return {
        replayed: false,
        case: await this.caseRepo.findOne({
          where: { id: caseId },
          relations: {
            review: true,
            notifications: true,
            currentGradeVersion: true,
          },
        }),
      };
    } catch (e: any) {
      // 并发下幂等键唯一约束：回放已有确认
      if (e?.constraint === 'review_decisions_idempotency_key_key' || /idempotency_key/.test(String(e?.detail ?? ''))) {
        const existing = await this.reviewRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey ?? IsNull() },
        });
        if (existing) {
          return {
            replayed: true,
            message: '并发重复确认请求已幂等回放',
            case: await this.caseRepo.findOne({
              where: { id: caseId },
              relations: { review: true, notifications: true },
            }),
          };
        }
      }
      throw e;
    }
  }
}
