import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { GradeCode } from '../common/enums';
import {
  addDays,
  diffDays,
  inclusiveDays,
  isValidDate,
} from '../common/date.util';
import { dailyTimesRate, moneyText } from '../common/money.util';
import { GradePeriodsService } from './grade-periods.service';

export interface FeeSegment {
  startDate: string;
  endDate: string;
  days: number;
  grade: GradeCode | null;
  dailyRate: string | null;
  amount: string;
  source:
    | 'GRADE_PERIOD_AND_RATE'
    | 'GRADE_PERIOD_NO_RATE'
    | 'NO_EFFECTIVE_GRADE';
  gradePeriodId: string | null;
  rateEffectiveFrom: string | null;
  note: string;
}

@Injectable()
export class FeesService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(GradeEffectivePeriod)
    private readonly periodRepo: Repository<GradeEffectivePeriod>,
    @InjectRepository(FeeRateVersion)
    private readonly rateRepo: Repository<FeeRateVersion>,
    private readonly gradePeriods: GradePeriodsService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 等级生效（机构示例规则，独立于告知是否送达）。
   * 同一老人同一天不能出现重叠生效等级：
   *  - 生效日落入当前开放区间且等级不同（如月中升级）：旧区间截至前一日，新区间自当日起
   *  - 同一天已有相同等级生效：视为重复请求，回放已有区间
   *  - 任何其他重叠（同日不同等级、回溯日期撞未来区间）：409
   * 数据库 gist 排他约束为最终防线。
   */
  async activateGrade(
    caseId: string,
    effectiveDate: string,
    idempotencyKey?: string,
  ) {
    if (!isValidDate(effectiveDate)) {
      throw new ConflictException({
        code: 'INVALID_DATE',
        message: `生效日期 ${effectiveDate} 不是合法公历日期`,
      });
    }

    const assessmentCase = await this.caseRepo.findOne({ where: { id: caseId } });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');
    if (!assessmentCase.confirmedGrade) {
      throw new ConflictException({
        code: 'GRADE_NOT_CONFIRMED',
        message: '等级尚未确认，不得生效费用',
      });
    }
    const grade = assessmentCase.confirmedGrade;

    return this.dataSource.transaction(async (em) => {
      const result = await this.gradePeriods.appendPeriod(em, {
        elderId: assessmentCase.elderId,
        grade,
        effectiveDate,
        sourceCaseId: caseId,
      });
      if (result.replayed) {
        return {
          replayed: true,
          message: '重复生效请求：同一天相同等级已生效，未重复生成',
          period: result.period,
        };
      }
      return { replayed: false, period: result.period };
    });
  }

  /**
   * 按天分段费用（闭区间 [from,to]，含首尾）：
   *  1) 取该老人与查询区间相交的等级期间，切成“天 × 等级”覆盖；
   *  2) 每段等级再按日费版本切换日拆分；
   *  3) decimal.js 计算 天数×日费 与合计；无生效等级的天空洞单列、金额 0。
   * 可传入事务 EntityManager：申诉裁决在同一事务内计算变更前后费用影响。
   */
  async feeSegments(
    elderId: string,
    from: string,
    to: string,
    em?: EntityManager,
  ): Promise<{ elderId: string; from: string; to: string; totalDays: number; totalAmount: string; segments: FeeSegment[] }> {
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      throw new ConflictException({
        code: 'INVALID_RANGE',
        message: '查询区间日期不合法或起止倒置',
      });
    }

    const periodRepo = em
      ? em.getRepository(GradeEffectivePeriod)
      : this.periodRepo;
    const rateRepo = em ? em.getRepository(FeeRateVersion) : this.rateRepo;

    const periods = await periodRepo.find({
      where: { elderId },
      order: { startDate: 'ASC' },
    });
    const rateVersions = await rateRepo.find({
      order: { effectiveFrom: 'ASC' },
    });

    // 1) 等级覆盖轴：闭区间片段 [{start,end,grade,periodId}]，grade/periodId 允许为空（空洞）
    type CoverPiece = {
      start: string;
      end: string;
      grade: GradeCode | null;
      periodId: string | null;
    };
    const cover: CoverPiece[] = [];
    for (const p of periods) {
      const pEndInclusive = p.endDateExclusive
        ? addDays(p.endDateExclusive, -1)
        : to; // 开放区间在查询范围内取 to
      const s = p.startDate > from ? p.startDate : from;
      const e = pEndInclusive < to ? pEndInclusive : to;
      if (s <= e) {
        cover.push({ start: s, end: e, grade: p.grade, periodId: p.id });
      }
    }
    cover.sort((a, b) => (a.start < b.start ? -1 : 1));

    // 2) 填充无生效等级的空洞，保证逐天连续
    const merged: CoverPiece[] = [];
    let cursor = from;
    for (const c of cover) {
      if (c.start > cursor) {
        merged.push({ start: cursor, end: addDays(c.start, -1), grade: null, periodId: null });
      }
      merged.push(c);
      cursor = c.end < cursor ? cursor : addDays(c.end, 1);
    }
    if (cursor <= to) {
      merged.push({ start: cursor, end: to, grade: null, periodId: null });
    }

    // 3) 按日费版本切换日二次切分
    const segments: FeeSegment[] = [];
    let total = new Decimal(0);
    let totalDays = 0;

    for (const m of merged) {
      totalDays += inclusiveDays(m.start, m.end);
      if (!m.grade) {
        segments.push({
          startDate: m.start,
          endDate: m.end,
          days: inclusiveDays(m.start, m.end),
          grade: null,
          dailyRate: null,
          amount: moneyText(0),
          source: 'NO_EFFECTIVE_GRADE',
          gradePeriodId: null,
          rateEffectiveFrom: null,
          note: '无生效等级：不计费',
        });
        continue;
      }

      const versions = rateVersions
        .filter(
          (r) => r.grade === m.grade && r.effectiveFrom <= m.end,
        )
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));

      let segStart = m.start;
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        const nextV = versions[i + 1];
        const vStart = v.effectiveFrom < segStart ? segStart : v.effectiveFrom;
        if (vStart > m.end) break;
        const vEndInclusive = nextV
          ? minString(addDays(nextV.effectiveFrom, -1), m.end)
          : m.end;
        if (vStart > vEndInclusive) continue;

        // 该版本是否覆盖段首，否则只是存在更早版本（已被 vStart 修正）
        const days = inclusiveDays(vStart, vEndInclusive);
        const amount = dailyTimesRate(v.dailyRate, days);
        total = total.plus(amount);
        segments.push({
          startDate: vStart,
          endDate: vEndInclusive,
          days,
          grade: m.grade,
          dailyRate: moneyText(v.dailyRate),
          amount: moneyText(amount),
          source: 'GRADE_PERIOD_AND_RATE',
          gradePeriodId: m.periodId,
          rateEffectiveFrom: v.effectiveFrom,
          note: `${m.grade} 等级期间 × 日费版本自 ${v.effectiveFrom} 起（${v.note ?? ''}）`,
        });
        segStart = addDays(vEndInclusive, 1);
      }

      // 等级存在但机构未定义任何日费规则
      if (!versions.length) {
        segments.push({
          startDate: m.start,
          endDate: m.end,
          days: inclusiveDays(m.start, m.end),
          grade: m.grade,
          dailyRate: null,
          amount: moneyText(0),
          source: 'GRADE_PERIOD_NO_RATE',
          gradePeriodId: m.periodId,
          rateEffectiveFrom: null,
          note: `等级 ${m.grade} 已生效但机构示例规则未定义日费：暂不计费`,
        });
      }
    }

    // 校验天数守恒（分段天数之和必须等于区间总天数）
    const segDays = segments.reduce((s, x) => s + x.days, 0);
    if (segDays !== diffDays(to, from) + 1) {
      throw new Error(
        `费用分段天数不一致：分段 ${segDays} 天，区间 ${diffDays(to, from) + 1} 天`,
      );
    }

    return {
      elderId,
      from,
      to,
      totalDays,
      totalAmount: moneyText(total),
      segments,
    };
  }
}

function minString(a: string, b: string): string {
  return a < b ? a : b;
}
