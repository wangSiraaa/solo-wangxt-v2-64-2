import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';

/**
 * 申诉闭环 e2e：
 * 期限内申诉维持原等级且完整留痕 / 补正后变更等级并生成前后费用差异 /
 * 送达失败或超期拒绝受理且不污染评估 / 撤回后迟到裁决不能生效 /
 * 并发裁决仅一个成功 / 过期状态机 / 重启后证据-决定-等级期间-告知链仍可复核
 */
describe('家属申诉闭环 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  const ITEMS_8 = [
    'TRANSFER',
    'WALKING',
    'BATHING',
    'DRESSING',
    'TOILETING',
    'EATING',
    'CONTINENCE',
    'GROOMING',
  ];

  function answers(override: Record<string, string> = {}) {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = 'INDEPENDENT';
    map.STAIRS = 'INDEPENDENT';
    map.OUTDOOR = 'INDEPENDENT';
    Object.assign(map, override);
    return Object.entries(map).map(([itemCode, optionCode]) => ({
      itemCode,
      optionCode,
    }));
  }

  function payload(
    elderId: string,
    a1: ReturnType<typeof answers>,
    a2: ReturnType<typeof answers>,
    familyContact = '13800000000',
  ) {
    return {
      elderId,
      elderName: `老人${elderId}`,
      familyContact,
      assessors: [
        { assessorId: 1, answers: a1 },
        { assessorId: 2, answers: a2 },
      ],
    };
  }

  /** 相对今天（UTC）偏移 days 天的 YYYY-MM-DD */
  function datePlus(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  async function buildApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance = moduleRef.createNestApplication();
    instance.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    instance.setGlobalPrefix('api');
    await instance.init();
    return instance;
  }

  /** 一致确认（LIGHT）案件 + 成功送达告知，返回案件与已送达告知 id */
  async function confirmedDeliveredCase(elderId: string, contact = '13800000000') {
    const created = await http
      .post('/api/assessments')
      .send(payload(elderId, answers({}), answers({}), contact))
      .expect(201);
    expect(created.body.status).toBe('CONFIRMED');
    expect(created.body.confirmedGrade).toBe(GradeCode.LIGHT);
    const attempt = await http
      .post(`/api/assessments/${created.body.id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(attempt.body.status).toBe('DELIVERED');
    return { caseId: created.body.id as string, notificationId: attempt.body.id as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    http = request(app.getHttpServer());
    const ds = app.get(DataSource);
    await ds.query(`
      TRUNCATE appeal_events, appeal_decisions, appeals,
               grade_periods, notification_records, review_decisions,
               assessor_answers, assessment_cases RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. 期限内申诉维持原等级且完整留痕
  // ---------------------------------------------------------------------------
  let upheldCaseId: string;
  let upheldAppealId: string;

  it('期限内申诉 → 补正 → 裁决维持：原等级不变、复核意见不改写、全程留痕', async () => {
    const { caseId, notificationId } = await confirmedDeliveredCase('E-APPEAL-UPHELD');
    upheldCaseId = caseId;

    const before = await http.get(`/api/assessments/${caseId}`).expect(200);
    const reviewComment = before.body.review.comment;

    // 期限内申诉（默认申诉日为当天），随附材料 → SUBMITTED
    const filed = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '家属认为进食与转移评估偏轻，要求复核',
        filedBy: 'family-li',
        materials: ['居家视频-2024.pdf'],
        idempotencyKey: 'upheld-file-1',
      })
      .expect(201);
    expect(filed.body.replayed).toBe(false);
    expect(filed.body.appeal.status).toBe('SUBMITTED');
    expect(filed.body.appeal.snapshotGrade).toBe(GradeCode.LIGHT);
    // 快照绑定：当时的量表答案（2 评估员 × 10 项）与送达记录
    expect(filed.body.appeal.snapshotAnswers).toHaveLength(20);
    expect(filed.body.appeal.snapshotDelivery.status).toBe('DELIVERED');
    expect(filed.body.appeal.snapshotDelivery.notificationId).toBe(notificationId);
    expect(filed.body.appeal.snapshotReview.result).toBe('AGREEMENT');
    upheldAppealId = filed.body.appeal.id;

    // 相同幂等键重复申诉 → 回放
    const replay = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '家属认为进食与转移评估偏轻，要求复核',
        filedBy: 'family-li',
        materials: ['居家视频-2024.pdf'],
        idempotencyKey: 'upheld-file-1',
      })
      .expect(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.appeal.id).toBe(upheldAppealId);

    // 已提交状态再补材料 → 待裁决
    const supplemented = await http
      .post(`/api/appeals/${upheldAppealId}/supplement`)
      .send({ materials: ['社区医生说明.pdf'], note: '补充佐证' })
      .expect(201);
    expect(supplemented.body.appeal.status).toBe('PENDING_ADJUDICATION');
    expect(supplemented.body.appeal.materials).toHaveLength(2);

    // 裁决维持
    const adjudicated = await http
      .post(`/api/appeals/${upheldAppealId}/adjudicate`)
      .send({
        decision: 'UPHELD',
        comment: '复核视频与原始量表，维持轻度结论',
        adjudicatorId: 'admin-zhao',
      })
      .expect(201);
    expect(adjudicated.body.appeal.status).toBe('UPHELD');
    expect(adjudicated.body.decision.decision).toBe('UPHELD');
    expect(adjudicated.body.decision.originalGrade).toBe(GradeCode.LIGHT);
    expect(adjudicated.body.decision.newGrade).toBeNull();
    expect(adjudicated.body.decision.feeImpact.unchanged).toBe(true);
    expect(adjudicated.body.decision.feeImpact.difference).toBe('0.00');

    // 完整留痕：FILED → SUPPLEMENTED → ADJUDICATED
    const detail = await http.get(`/api/appeals/${upheldAppealId}`).expect(200);
    expect(detail.body.events.map((e: any) => e.action)).toEqual([
      'FILED',
      'SUPPLEMENTED',
      'ADJUDICATED',
    ]);
    expect(detail.body.decision.comment).toContain('维持轻度');

    // 原等级不变、原复核意见未被改写
    const after = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(after.body.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(after.body.review.comment).toBe(reviewComment);
    // 告知链：自动 PENDING + 成功送达 + 裁决结果告知（PENDING）
    expect(after.body.notifications).toHaveLength(3);
    expect(after.body.notifications[2].message).toContain('维持原等级');

    // 维持裁决不产生任何等级期间
    const ds = app.get(DataSource);
    const periods = await ds.query(
      `SELECT 1 FROM grade_periods WHERE elder_id = 'E-APPEAL-UPHELD'`,
    );
    expect(periods).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. 补正后变更等级并生成前后费用差异
  // ---------------------------------------------------------------------------
  let changedCaseId: string;
  let changedAppealId: string;

  it('待补正 → 补正（幂等）→ 变更裁决：追加新等级版本并按生效日给出前后费用差异', async () => {
    const { caseId, notificationId } = await confirmedDeliveredCase('E-APPEAL-CHANGED');
    changedCaseId = caseId;

    // 原等级 LIGHT 自 2024-01-01 起生效（开放区间）
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-01-01' })
      .expect(201);

    // 材料不足 → 待补正
    const filed = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '老人近期已无法独立行走与转移，原等级明显偏低',
        filedBy: 'family-wang',
      })
      .expect(201);
    expect(filed.body.appeal.status).toBe('PENDING_CORRECTION');
    changedAppealId = filed.body.appeal.id;

    // 待补正期间不得裁决
    const early = await http
      .post(`/api/appeals/${changedAppealId}/adjudicate`)
      .send({
        decision: 'UPHELD',
        comment: '材料未齐即裁决',
        adjudicatorId: 'admin-li',
      })
      .expect(409);
    expect(JSON.stringify(early.body)).toContain('APPEAL_AWAITING_CORRECTION');

    // 补正 → 待裁决；同键重复补正 → 幂等回放，材料不重复
    const sup1 = await http
      .post(`/api/appeals/${changedAppealId}/supplement`)
      .send({
        materials: ['医院诊断证明.pdf', '护理记录-3月.pdf'],
        idempotencyKey: 'changed-sup-1',
      })
      .expect(201);
    expect(sup1.body.replayed).toBe(false);
    expect(sup1.body.appeal.status).toBe('PENDING_ADJUDICATION');
    expect(sup1.body.appeal.materials).toHaveLength(2);

    const sup2 = await http
      .post(`/api/appeals/${changedAppealId}/supplement`)
      .send({
        materials: ['医院诊断证明.pdf', '护理记录-3月.pdf'],
        idempotencyKey: 'changed-sup-1',
      })
      .expect(201);
    expect(sup2.body.replayed).toBe(true);
    expect(sup2.body.appeal.materials).toHaveLength(2);

    // 变更裁决：LIGHT → SEVERE，自 2024-02-15 生效
    const adjudicated = await http
      .post(`/api/appeals/${changedAppealId}/adjudicate`)
      .send({
        decision: 'CHANGED',
        newGrade: GradeCode.SEVERE,
        effectiveDate: '2024-02-15',
        comment: '补充材料充分，复评后认定为重度',
        adjudicatorId: 'admin-li',
        idempotencyKey: 'changed-adj-1',
      })
      .expect(201);
    expect(adjudicated.body.appeal.status).toBe('CHANGED');
    const decision = adjudicated.body.decision;
    expect(decision.originalGrade).toBe(GradeCode.LIGHT);
    expect(decision.newGrade).toBe(GradeCode.SEVERE);
    expect(decision.effectiveDate).toBe('2024-02-15');
    expect(decision.gradePeriodId).toBeTruthy();

    // 前后费用差异：旧期间开放 → 演示窗口 30 天（2024-02-15 ~ 2024-03-15）
    const impact = decision.feeImpact;
    expect(impact.windowStart).toBe('2024-02-15');
    expect(impact.windowEnd).toBe('2024-03-15');
    expect(impact.days).toBe(30);
    expect(impact.before.totalAmount).toBe('3000.00'); // 30 天 × 100
    expect(impact.after.totalAmount).toBe('9000.00'); // 30 天 × 300
    expect(impact.difference).toBe('6000.00');

    // 新等级版本已追加：旧 LIGHT 期间截断至 2/14，SEVERE 自 2/15 起
    const segments = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-APPEAL-CHANGED', from: '2024-02-01', to: '2024-02-29' })
      .expect(200);
    expect(segments.body.segments).toHaveLength(2);
    expect(segments.body.segments[0].grade).toBe(GradeCode.LIGHT);
    expect(segments.body.segments[0].days).toBe(14);
    expect(segments.body.segments[1].grade).toBe(GradeCode.SEVERE);
    expect(segments.body.segments[1].days).toBe(15);
    expect(segments.body.totalAmount).toBe('5900.00');

    // 新等级版本可追溯来源申诉
    const ds = app.get(DataSource);
    const periodRows = await ds.query(
      `SELECT grade, start_date::text AS s, end_date_exclusive::text AS e, source_appeal_id
         FROM grade_periods WHERE elder_id = 'E-APPEAL-CHANGED' ORDER BY start_date`,
    );
    expect(periodRows).toHaveLength(2);
    expect(periodRows[0]).toMatchObject({ grade: 'LIGHT', s: '2024-01-01', e: '2024-02-15' });
    expect(periodRows[1]).toMatchObject({
      grade: 'SEVERE',
      s: '2024-02-15',
      e: null,
      source_appeal_id: changedAppealId,
    });

    // 当前等级更新为新等级；原复核意见（AGREEMENT 系统意见）不改写
    const caseAfter = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(caseAfter.body.confirmedGrade).toBe(GradeCode.SEVERE);
    expect(caseAfter.body.review.result).toBe('AGREEMENT');
    expect(caseAfter.body.review.comment).toContain('系统自动确认');

    // 重复裁决：同键回放；异键 409；终态后补正 409（乱序拒绝）
    const again = await http
      .post(`/api/appeals/${changedAppealId}/adjudicate`)
      .send({
        decision: 'CHANGED',
        newGrade: GradeCode.SEVERE,
        effectiveDate: '2024-02-15',
        comment: '补充材料充分，复评后认定为重度',
        adjudicatorId: 'admin-li',
        idempotencyKey: 'changed-adj-1',
      })
      .expect(201);
    expect(again.body.replayed).toBe(true);

    await http
      .post(`/api/appeals/${changedAppealId}/adjudicate`)
      .send({
        decision: 'UPHELD',
        comment: '另一位管理员迟到裁决',
        adjudicatorId: 'admin-other',
      })
      .expect(409);

    await http
      .post(`/api/appeals/${changedAppealId}/supplement`)
      .send({ materials: ['迟到的材料.pdf'] })
      .expect(409);
  });

  // ---------------------------------------------------------------------------
  // 3. 送达失败 / 未送达：拒绝受理且不污染评估
  // ---------------------------------------------------------------------------
  it('送达失败或未送达的告知：申诉拒绝受理，评估与告知链不受污染', async () => {
    const created = await http
      .post('/api/assessments')
      .send(payload('E-APPEAL-NODLV', answers({}), answers({}), '138-FAIL'))
      .expect(201);
    const caseId = created.body.id;
    const pendingNotificationId = created.body.notifications[0].id;

    // 送达失败记录
    const failed = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({})
      .expect(201);
    expect(failed.body.status).toBe('FAILED');

    // 对 FAILED 告知申诉 → 409
    const rejected1 = await http
      .post('/api/appeals')
      .send({
        notificationId: failed.body.id,
        reason: '家属对等级有异议',
        filedBy: 'family-xu',
      })
      .expect(409);
    expect(JSON.stringify(rejected1.body)).toContain('APPEAL_NOTIFICATION_NOT_DELIVERED');

    // 对 PENDING（未送达）告知申诉 → 409
    await http
      .post('/api/appeals')
      .send({
        notificationId: pendingNotificationId,
        reason: '家属对等级有异议',
        filedBy: 'family-xu',
      })
      .expect(409);

    // 不存在的告知 → 404
    await http
      .post('/api/appeals')
      .send({
        notificationId: '00000000-0000-0000-0000-000000000000',
        reason: '家属对等级有异议',
        filedBy: 'family-xu',
      })
      .expect(404);

    // 不污染评估：案件状态/等级/告知链不变，无申诉记录
    const after = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(after.body.status).toBe('CONFIRMED');
    expect(after.body.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(after.body.notifications).toHaveLength(2);
    const appeals = await http
      .get(`/api/assessments/${caseId}/appeals`)
      .expect(200);
    expect(appeals.body).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 4. 超过申诉期限：拒绝受理且不产生数据
  // ---------------------------------------------------------------------------
  it('超过申诉期限拒绝受理；期限内（含边界）正常受理', async () => {
    const { caseId, notificationId } = await confirmedDeliveredCase('E-APPEAL-LATE');

    // 送达日 = 今天，窗口 30 天：+31 天 → 超期
    const late = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '超期提出的异议',
        filedBy: 'family-late',
        filedOn: datePlus(31),
      })
      .expect(409);
    expect(JSON.stringify(late.body)).toContain('APPEAL_WINDOW_EXPIRED');

    // 申诉日早于送达日 → 400
    await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '日期倒挂的异议',
        filedBy: 'family-late',
        filedOn: datePlus(-1),
      })
      .expect(400);

    // 期限边界（+30 天）→ 受理
    const onTime = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '期限最后一天提出的异议',
        filedBy: 'family-late',
        filedOn: datePlus(30),
        materials: ['材料.pdf'],
      })
      .expect(201);
    expect(onTime.body.appeal.status).toBe('SUBMITTED');

    // 仅一条申诉落库（超期/倒挂均未产生数据）
    const appeals = await http
      .get(`/api/assessments/${caseId}/appeals`)
      .expect(200);
    expect(appeals.body).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 5. 撤回后迟到裁决不能生效
  // ---------------------------------------------------------------------------
  it('撤回（幂等）后迟到的裁决不得生效，不产生等级期间', async () => {
    const { caseId, notificationId } = await confirmedDeliveredCase('E-APPEAL-WD');
    const filed = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '家属提出异议后决定撤回',
        filedBy: 'family-qian',
        materials: ['材料.pdf'],
      })
      .expect(201);
    const appealId = filed.body.appeal.id;

    const withdrawn = await http
      .post(`/api/appeals/${appealId}/withdraw`)
      .send({ withdrawnBy: 'family-qian', reason: '家庭内部再商议' })
      .expect(201);
    expect(withdrawn.body.appeal.status).toBe('WITHDRAWN');

    // 重复撤回 → 幂等回放
    const again = await http
      .post(`/api/appeals/${appealId}/withdraw`)
      .send({ withdrawnBy: 'family-qian' })
      .expect(201);
    expect(again.body.replayed).toBe(true);

    // 迟到裁决 → 409，不生效
    const late = await http
      .post(`/api/appeals/${appealId}/adjudicate`)
      .send({
        decision: 'CHANGED',
        newGrade: GradeCode.MODERATE,
        effectiveDate: '2024-05-01',
        comment: '撤回后迟到的变更裁决',
        adjudicatorId: 'admin-sun',
      })
      .expect(409);
    expect(JSON.stringify(late.body)).toContain('APPEAL_ALREADY_WITHDRAWN');

    const detail = await http.get(`/api/appeals/${appealId}`).expect(200);
    expect(detail.body.status).toBe('WITHDRAWN');
    expect(detail.body.decision).toBeNull();
    expect(detail.body.events.map((e: any) => e.action)).toEqual([
      'FILED',
      'WITHDRAWN',
    ]);

    // 无等级期间、案件等级不变
    const ds = app.get(DataSource);
    const periods = await ds.query(
      `SELECT 1 FROM grade_periods WHERE elder_id = 'E-APPEAL-WD'`,
    );
    expect(periods).toHaveLength(0);
    const caseAfter = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(caseAfter.body.confirmedGrade).toBe(GradeCode.LIGHT);

    // 撤回后同一告知可再次申诉（进行中的只有一条）
    const refiled = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '商议后重新提出异议',
        filedBy: 'family-qian',
        materials: ['新材料.pdf'],
      })
      .expect(201);
    expect(refiled.body.appeal.status).toBe('SUBMITTED');
  });

  // ---------------------------------------------------------------------------
  // 6. 相同告知只能有一个进行中的申诉
  // ---------------------------------------------------------------------------
  it('同一告知存在进行中申诉时，再次申诉 409', async () => {
    const { notificationId } = await confirmedDeliveredCase('E-APPEAL-ONEOPEN');
    await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '第一次异议',
        filedBy: 'family-du',
        materials: ['材料.pdf'],
      })
      .expect(201);

    const dup = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '第二次异议（应被拒绝）',
        filedBy: 'family-du',
        materials: ['材料.pdf'],
      })
      .expect(409);
    expect(JSON.stringify(dup.body)).toContain('APPEAL_ALREADY_OPEN');
  });

  // ---------------------------------------------------------------------------
  // 7. 两个管理员并发裁决：仅一个成功
  // ---------------------------------------------------------------------------
  it('并发裁决：行锁 + 唯一约束保证仅一个生效，不产生两条有效等级', async () => {
    const { caseId, notificationId } = await confirmedDeliveredCase('E-APPEAL-RACE');
    const filed = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '并发裁决测试用异议',
        filedBy: 'family-race',
        materials: ['材料.pdf'],
      })
      .expect(201);
    const appealId = filed.body.appeal.id;

    const adminA = http.post(`/api/appeals/${appealId}/adjudicate`).send({
      decision: 'CHANGED',
      newGrade: GradeCode.SEVERE,
      effectiveDate: '2024-03-01',
      comment: '管理员A裁决变更为重度',
      adjudicatorId: 'admin-A',
    });
    const adminB = http.post(`/api/appeals/${appealId}/adjudicate`).send({
      decision: 'CHANGED',
      newGrade: GradeCode.MODERATE,
      effectiveDate: '2024-03-01',
      comment: '管理员B裁决变更为中度',
      adjudicatorId: 'admin-B',
    });
    const [resA, resB] = await Promise.all([adminA, adminB]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 201 ? resB : resA;
    expect(JSON.stringify(loser.body)).toContain('APPEAL_ALREADY_ADJUDICATED');

    // 仅一条裁决、一条等级期间；案件等级与裁决一致
    const detail = await http.get(`/api/appeals/${appealId}`).expect(200);
    expect(detail.body.status).toBe('CHANGED');
    expect(detail.body.decision).toBeTruthy();
    expect(
      detail.body.events.filter((e: any) => e.action === 'ADJUDICATED'),
    ).toHaveLength(1);

    const ds = app.get(DataSource);
    const periods = await ds.query(
      `SELECT grade FROM grade_periods WHERE elder_id = 'E-APPEAL-RACE'`,
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].grade).toBe(winner.body.decision.newGrade);
    const decisions = await ds.query(
      `SELECT 1 FROM appeal_decisions WHERE appeal_id = '${appealId}'`,
    );
    expect(decisions).toHaveLength(1);

    const caseAfter = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(caseAfter.body.confirmedGrade).toBe(winner.body.decision.newGrade);
  });

  // ---------------------------------------------------------------------------
  // 8. 待补正超期 → 过期（EXPIRED）
  // ---------------------------------------------------------------------------
  it('待补正超过补正期限：惰性落 EXPIRED，补正/裁决/撤回均拒绝', async () => {
    const { notificationId } = await confirmedDeliveredCase('E-APPEAL-EXPIRE');
    const filed = await http
      .post('/api/appeals')
      .send({
        notificationId,
        reason: '材料迟迟未补齐的异议',
        filedBy: 'family-guo',
        correctionDeadline: datePlus(-1), // 演示参数：补正期限设为昨天
      })
      .expect(201);
    // 受理时落 PENDING_CORRECTION；回读即触发惰性过期（补正期限已过）
    expect(filed.body.appeal.status).toBe('EXPIRED');
    const appealId = filed.body.appeal.id;

    // 补正触发惰性过期 → 409
    const sup = await http
      .post(`/api/appeals/${appealId}/supplement`)
      .send({ materials: ['迟到的补正.pdf'] })
      .expect(409);
    expect(JSON.stringify(sup.body)).toContain('APPEAL_EXPIRED');

    // 状态已落 EXPIRED 并留痕
    const detail = await http.get(`/api/appeals/${appealId}`).expect(200);
    expect(detail.body.status).toBe('EXPIRED');
    expect(detail.body.events.map((e: any) => e.action)).toEqual([
      'FILED',
      'EXPIRED',
    ]);

    // 裁决 / 撤回同样拒绝
    await http
      .post(`/api/appeals/${appealId}/adjudicate`)
      .send({
        decision: 'UPHELD',
        comment: '对已过期申诉的裁决',
        adjudicatorId: 'admin-he',
      })
      .expect(409);
    await http
      .post(`/api/appeals/${appealId}/withdraw`)
      .send({ withdrawnBy: 'family-guo' })
      .expect(409);
  });

  // ---------------------------------------------------------------------------
  // 9. OpenAPI 文档可用
  // ---------------------------------------------------------------------------
  it('OpenAPI 文档暴露申诉闭环全部接口', async () => {
    const res = await http.get('/api/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.0.3');
    for (const p of [
      '/appeals',
      '/appeals/{id}',
      '/appeals/{id}/supplement',
      '/appeals/{id}/withdraw',
      '/appeals/{id}/adjudicate',
      '/assessments/{caseId}/appeals',
    ]) {
      expect(res.body.paths[p]).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // 10. 重启后：证据、决定、等级期间与既有告知链仍可复核
  // ---------------------------------------------------------------------------
  it('服务重启后：申诉证据、裁决决定、等级期间与告知链完整可复核', async () => {
    // 重启（同一数据库，嵌入式 PG 由测试 setup 持有）
    await app.close();
    app = await buildApp();
    http = request(app.getHttpServer());

    // 证据与决定仍在（取自场景 2 的变更裁决）
    const detail = await http.get(`/api/appeals/${changedAppealId}`).expect(200);
    expect(detail.body.status).toBe('CHANGED');
    expect(detail.body.snapshotGrade).toBe(GradeCode.LIGHT);
    expect(detail.body.snapshotAnswers).toHaveLength(20);
    expect(detail.body.snapshotDelivery.status).toBe('DELIVERED');
    expect(detail.body.materials).toHaveLength(2);
    expect(detail.body.events.map((e: any) => e.action)).toEqual([
      'FILED',
      'SUPPLEMENTED',
      'ADJUDICATED',
    ]);
    expect(detail.body.decision.newGrade).toBe(GradeCode.SEVERE);
    expect(detail.body.decision.feeImpact.difference).toBe('6000.00');

    // 案件维度历史可复核
    const history = await http
      .get(`/api/assessments/${changedCaseId}/appeals`)
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].id).toBe(changedAppealId);

    // 等级期间与费用分段不变
    const segments = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-APPEAL-CHANGED', from: '2024-02-01', to: '2024-02-29' })
      .expect(200);
    expect(segments.body.totalAmount).toBe('5900.00');
    expect(segments.body.segments[1].grade).toBe(GradeCode.SEVERE);

    // 既有告知链完整（自动 PENDING + 送达 + 裁决告知）
    const caseAfter = await http
      .get(`/api/assessments/${changedCaseId}`)
      .expect(200);
    expect(caseAfter.body.notifications).toHaveLength(3);
    expect(caseAfter.body.notifications[1].status).toBe('DELIVERED');
    expect(caseAfter.body.notifications[2].message).toContain('调整为');
    // 维持案例同样可复核
    const upheld = await http.get(`/api/appeals/${upheldAppealId}`).expect(200);
    expect(upheld.body.status).toBe('UPHELD');
    expect(upheld.body.decision.decision).toBe('UPHELD');
  }, 120_000);
});
