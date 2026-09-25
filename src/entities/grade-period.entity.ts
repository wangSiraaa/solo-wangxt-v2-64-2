import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GradeCode } from '../common/enums';

/**
 * 老人已生效等级期间（半开区间 [startDate, endDateExclusive)）。
 * 同一老人同一天不得出现重叠生效等级：
 *   数据库排除约束 grade_periods_no_overlap（btree_gist + daterange）为最终防线，
 *   服务层先做显式重叠校验给出可读错误。
 */
@Entity('grade_periods')
@Index(['elderId', 'startDate'])
export class GradeEffectivePeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'grade', type: 'varchar', length: 20 })
  grade: GradeCode;

  /** 生效首日 YYYY-MM-DD */
  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  /** 失效日（不含）；null 表示开放区间。结束时写入最后生效日的次日 */
  @Column({ name: 'end_date_exclusive', type: 'date', nullable: true })
  endDateExclusive: string | null;

  /** 来源评估案件 */
  @Column({ name: 'source_case_id', type: 'uuid' })
  sourceCaseId: string;

  /** 来源申诉（申诉裁决变更追加的等级版本；普通生效为 null） */
  @Column({ name: 'source_appeal_id', type: 'uuid', nullable: true })
  sourceAppealId: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
