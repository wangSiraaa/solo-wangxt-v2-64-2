import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GradeCode } from '../common/enums';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';

export interface AppendPeriodArgs {
  elderId: string;
  grade: GradeCode;
  effectiveDate: string;
  sourceCaseId: string;
  /** 申诉裁决变更追加的等级版本：记录来源申诉 */
  sourceAppealId?: string | null;
}

export interface AppendPeriodResult {
  replayed: boolean;
  period: GradeEffectivePeriod;
  /** 被新期间截断的旧期间 id（无截断为 null） */
  truncatedPeriodId: string | null;
}

/**
 * 等级期间写入的唯一入口（费用生效与申诉裁决变更共用）：
 * 行锁锁定该老人全部期间 → 显式重叠校验 → 插入，
 * PostgreSQL gist 排他约束 grade_periods_no_overlap 为最终防线。
 * 半开区间 [start, end)：月中换级时旧期间截至生效日前一日，首尾相接。
 */
@Injectable()
export class GradePeriodsService {
  /** 行锁读取该老人全部期间（date 列统一转文本，避免 JS Date 时区漂移） */
  async lockPeriods(em: EntityManager, elderId: string) {
    return em.query(
      `SELECT id, grade,
              start_date::text AS start_date,
              end_date_exclusive::text AS end_date_exclusive,
              source_case_id
         FROM grade_periods WHERE elder_id = $1
         ORDER BY start_date FOR UPDATE`,
      [elderId],
    ) as Promise<
      {
        id: string;
        grade: GradeCode;
        start_date: string;
        end_date_exclusive: string | null;
        source_case_id: string;
      }[]
    >;
  }

  async appendPeriod(
    em: EntityManager,
    args: AppendPeriodArgs,
  ): Promise<AppendPeriodResult> {
    const { elderId, grade, effectiveDate, sourceCaseId } = args;
    const periods = await this.lockPeriods(em, elderId);

    // 幂等：同案件 + 同生效日 + 同等级已存在
    const duplicate = periods.find(
      (p) =>
        p.source_case_id === sourceCaseId &&
        p.start_date === effectiveDate &&
        p.grade === grade,
    );
    if (duplicate) {
      return {
        replayed: true,
        period: (await em.findOne(GradeEffectivePeriod, {
          where: { id: duplicate.id },
        }))!,
        truncatedPeriodId: null,
      };
    }

    let truncatedPeriodId: string | null = null;

    // 半开区间重叠：new=[d, ∞)
    for (const p of periods) {
      const pEnd = p.end_date_exclusive ?? '9999-12-31';
      const overlaps = effectiveDate < pEnd; // new 结束为 ∞，故只需判断 d < p.end
      if (!overlaps) continue;

      if (p.start_date === effectiveDate) {
        // 同一天已有生效等级
        if (p.grade === grade) {
          return {
            replayed: true,
            period: (await em.findOne(GradeEffectivePeriod, {
              where: { id: p.id },
            }))!,
            truncatedPeriodId: null,
          };
        }
        throw new ConflictException({
          code: 'GRADE_PERIOD_OVERLAP_SAME_DAY',
          message: `生效日 ${effectiveDate} 已存在等级 ${p.grade}，同日不得重叠生效 ${grade}`,
          existingPeriodId: p.id,
        });
      }

      if (p.start_date < effectiveDate) {
        // 生效日落入已有区间内部（仅可能是开放区间或尚未结束的区间）
        if (p.grade === grade) {
          throw new ConflictException({
            code: 'GRADE_ALREADY_EFFECTIVE',
            message: `等级 ${grade} 已自 ${p.start_date} 起生效，同等级无需重复生效（日费调价由费用规则分段处理）`,
            existingPeriodId: p.id,
          });
        }
        // 月中升级/换级：旧区间截至生效日前一日
        await em.query(
          `UPDATE grade_periods SET end_date_exclusive = $1 WHERE id = $2`,
          [effectiveDate, p.id],
        );
        truncatedPeriodId = p.id;
      } else {
        // 回溯日期撞到未来区间
        throw new ConflictException({
          code: 'BACKDATED_OVERLAP',
          message: `生效日 ${effectiveDate} 早于已有未来生效区间（${p.start_date} 起 ${p.grade}），不得回溯重叠`,
          existingPeriodId: p.id,
        });
      }
    }

    try {
      const created = await em.save(GradeEffectivePeriod, {
        elderId,
        grade,
        startDate: effectiveDate,
        endDateExclusive: null,
        sourceCaseId,
        sourceAppealId: args.sourceAppealId ?? null,
      });
      return { replayed: false, period: created, truncatedPeriodId };
    } catch (e: any) {
      if (e?.constraint === 'grade_periods_no_overlap') {
        throw new ConflictException({
          code: 'GRADE_PERIOD_OVERLAP_SAME_DAY',
          message: '同一天存在重叠生效等级（数据库排他约束拦截）',
        });
      }
      throw e;
    }
  }
}
