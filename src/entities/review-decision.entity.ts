import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GradeCode, ReviewResult } from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';
import { GradeVersion } from './grade-version.entity';

/** 管理复核意见：冲突案件必须人工复核，不得简单取较高等级 */
@Entity('review_decisions')
export class ReviewDecision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => AssessmentCase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  @Column({ name: 'result', type: 'varchar', length: 20 })
  result: ReviewResult;

  /** 复核确认的最终等级 */
  @Column({ name: 'confirmed_grade', type: 'varchar', length: 20 })
  confirmedGrade: GradeCode;

  /** 复核员；系统一致确认时为 SYSTEM */
  @Column({ name: 'reviewer_id', type: 'varchar', length: 64, default: 'SYSTEM' })
  reviewerId: string;

  /** 复核意见原文 */
  @Column({ name: 'comment', type: 'text' })
  comment: string;

  /** 幂等键：同键重复提交视为重复确认请求 */
  @Index('review_decisions_idempotency_key_key', {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ name: 'decided_at' })
  decidedAt: Date;

  @OneToMany(() => GradeVersion, (g) => g.sourceReview)
  gradeVersions: GradeVersion[];
}
