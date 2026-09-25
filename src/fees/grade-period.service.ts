import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { addDays } from '../common/date.util';
import { dailyTimesRate, moneyText } from '../common/money.util';

/**
 * 原子地把某个等级版本应用到老人的等级期间轴。
 * 调用方必须已持有业务事务；与 /fees/activate 使用相同的半开区间规则。
 */
@Injectable()
export class GradePeriodService {

  async applyVersion(
    em: EntityManager,
    args: {
      elderId: string;
      caseId: string;
      gradeVersionId: string;
      grade: string;
      effectiveDate: string;
    },
  ): Promise<GradeEffectivePeriod> {
    const periods = await em.query(
      `SELECT id, grade,
              start_date::text AS start_date,
              end_date_exclusive::text AS end_date_exclusive,
              source_case_id, grade_version_id
         FROM grade_periods WHERE elder_id = $1
         ORDER BY start_date FOR UPDATE`,
      [args.elderId],
    );

    for (const p of periods as any[]) {
      const pEnd = p.end_date_exclusive ?? '9999-12-31';
      if (args.effectiveDate >= pEnd) continue;

      if (p.start_date === args.effectiveDate) {
        if (p.grade_version_id === args.gradeVersionId) {
          return em.findOneOrFail(GradeEffectivePeriod, { where: { id: p.id } });
        }
        throw new ConflictException({
          code: 'GRADE_PERIOD_OVERLAP_SAME_DAY',
          message: `生效日 ${args.effectiveDate} 已存在等级 ${p.grade}，同日不得重叠生效 ${args.grade}`,
          existingPeriodId: p.id,
        });
      }

      if (p.start_date < args.effectiveDate) {
        if (p.grade === args.grade) {
          throw new ConflictException({
            code: 'GRADE_ALREADY_EFFECTIVE',
            message: `等级 ${args.grade} 已自 ${p.start_date} 起生效`,
            existingPeriodId: p.id,
          });
        }
        await em.query(
          `UPDATE grade_periods SET end_date_exclusive = $1 WHERE id = $2`,
          [args.effectiveDate, p.id],
        );
      } else {
        throw new ConflictException({
          code: 'BACKDATED_OVERLAP',
          message: `生效日 ${args.effectiveDate} 早于已有未来生效区间（${p.start_date} 起 ${p.grade}），不得回溯重叠`,
          existingPeriodId: p.id,
        });
      }
    }

    try {
      const period = new GradeEffectivePeriod();
      period.elderId = args.elderId;
      period.grade = args.grade as GradeEffectivePeriod['grade'];
      period.startDate = args.effectiveDate;
      period.endDateExclusive = null;
      period.sourceCaseId = args.caseId;
      period.gradeVersionId = args.gradeVersionId;
      return await em.save(period);
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

  /** 计算指定闭区间内，若固定使用某等级的费用（按日费版本逐日分段） */
  async quoteGradeFee(
    em: EntityManager,
    grade: string,
    from: string,
    to: string,
  ) {
    const rates: any[] = await em.query(
      `SELECT effective_from::text AS effective_from, daily_rate::text AS daily_rate, note
         FROM fee_rate_versions
        WHERE grade = $1 AND effective_from <= $2
        ORDER BY effective_from`,
      [grade, to],
    );

    const segments: Array<{
      startDate: string;
      endDate: string;
      days: number;
      grade: string;
      dailyRate: string;
      amount: string;
    }> = [];

    let cursor = from;
    let total = new Decimal(0);
    for (let i = 0; i < rates.length; i++) {
      const rate = rates[i];
      const next = rates[i + 1];
      const start = cursor < rate.effective_from ? rate.effective_from : cursor;
      if (start > to) break;
      const end = next ? min(addDays(next.effective_from, -1), to) : to;
      if (start <= end) {
        const days = dateDiffDays(start, end) + 1;
        const amount = dailyTimesRate(rate.daily_rate, days);
        total = total.plus(amount);
        segments.push({
          startDate: start,
          endDate: end,
          days,
          grade,
          dailyRate: moneyText(rate.daily_rate),
          amount: moneyText(amount),
        });
        cursor = addDays(end, 1);
      }
    }
    return { totalAmount: moneyText(total), segments };
  }
}

function min(a: string, b: string): string {
  return a < b ? a : b;
}

function dateDiffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
