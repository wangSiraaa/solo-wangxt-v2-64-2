import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';

describe('家属申诉闭环 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ds: DataSource;

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
  const OPT = {
    INDEPENDENT: 'INDEPENDENT',
    SOME_HELP: 'SOME_HELP',
    MUCH_HELP: 'MUCH_HELP',
    TOTAL_DEP: 'TOTAL_DEP',
    NA: 'NA',
  };

  function answers(override: Record<string, string> = {}) {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = OPT.INDEPENDENT;
    map.STAIRS = OPT.INDEPENDENT;
    map.OUTDOOR = OPT.INDEPENDENT;
    Object.assign(map, override);
    return Object.entries(map).map(([itemCode, optionCode]) => ({ itemCode, optionCode }));
  }

  function severeAnswers() {
    const o: Record<string, string> = {};
    for (const code of ITEMS_8) o[code] = OPT.TOTAL_DEP;
    o.STAIRS = OPT.TOTAL_DEP;
    o.OUTDOOR = OPT.INDEPENDENT;
    return answers(o);
  }

  function payload(elderId: string, a1: any[], a2: any[], familyContact = '13900000000') {
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

  const materials = (prefix: string) => [
    { fileName: `${prefix}.pdf`, fileRef: `oss://${prefix}.pdf`, note: '补充说明' },
  ];

  async function createConfirmedCase(elderId: string, grade: GradeCode) {
    const created = await http
      .post('/api/assessments')
      .send(payload(
        elderId,
        grade === GradeCode.SEVERE ? answers({ EATING: OPT.SOME_HELP }) : severeAnswers(),
        grade === GradeCode.SEVERE ? severeAnswers() : answers({ EATING: OPT.SOME_HELP }),
      ))
      .expect(201);
    let caseId = created.body.id;
    if (created.body.status === 'PENDING_REVIEW') {
      const confirm = await http
        .post(`/api/assessments/${caseId}/review/confirm`)
        .send({
          confirmedGrade: grade,
          reviewerId: 'reviewer-a',
          comment: '管理复核确认演示等级并留下完整意见',
        })
        .expect(201);
      expect(confirm.body.case.confirmedGrade).toBe(grade);
    } else {
      expect(created.body.confirmedGrade).toBe(grade);
    }
    const delivered = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({})
      .expect(201);
    expect(delivered.body.status).toBe('DELIVERED');
    return { caseId, notificationId: delivered.body.id };
  }

  async function submitAppeal(caseId: string, notificationId: string, key?: string) {
    const res = await http
      .post(`/api/assessments/${caseId}/appeals`)
      .send({
        notificationId,
        familyRequester: '张家属',
        reason: '家属认为日常表现与评估结果不一致，要求重新查看记录',
        materials: materials('initial-evidence'),
        ...(key ? { idempotencyKey: key } : {}),
      })
      .expect(201);
    return res.body.appeal;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    ds = app.get(DataSource);
    await ds.query(`
      TRUNCATE grade_periods, notification_records, review_decisions,
               assessor_answers, assessment_cases, grade_versions,
               appeals, appeal_events, appeal_materials
      RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('期限内申诉：补正后裁决维持，原复核意见不变且证据链完整留痕', async () => {
    const { caseId, notificationId } = await createConfirmedCase(
      'APPEAL-UPHOLD',
      GradeCode.LIGHT,
    );
    const beforeCase = await http.get(`/api/assessments/${caseId}`).expect(200);
    const originalReview = beforeCase.body.review;

    const appeal = await submitAppeal(caseId, notificationId, 'appeal-uphold-submit');
    expect(appeal.status).toBe('SUBMITTED');
    expect(appeal.boundGradeVersionId).toBe(beforeCase.body.currentGradeVersionId);
    expect(appeal.gradeSnapshot.grade).toBe(GradeCode.LIGHT);
    expect(appeal.gradeSnapshot.review.comment).toBe(originalReview.comment);
    expect(appeal.answersSnapshot.rows.length).toBeGreaterThan(0);
    expect(appeal.deliverySnapshot.notificationId).toBe(notificationId);
    expect(appeal.deliverySnapshot.status).toBe('DELIVERED');
    expect(appeal.materials).toHaveLength(1);

    const dup = await http
      .post(`/api/assessments/${caseId}/appeals`)
      .send({
        notificationId,
        familyRequester: '张家属',
        reason: '重复申诉应被拦截',
        materials: materials('dup'),
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ACTIVE_APPEAL_EXISTS');

    const replay = await http
      .post(`/api/assessments/${caseId}/appeals`)
      .send({
        notificationId,
        familyRequester: '张家属',
        reason: '家属认为日常表现与评估结果不一致，要求重新查看记录',
        materials: materials('initial-evidence'),
        idempotencyKey: 'appeal-uphold-submit',
      })
      .expect(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.appeal.id).toBe(appeal.id);

    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/corrections`)
      .send({
        reviewerId: 'caseworker-1',
        requestComment: '请补充近一周护理记录与影像材料',
        dueDate: '2099-01-01',
        idempotencyKey: 'appeal-uphold-correction',
      })
      .expect(201)
      .expect((r) => expect(r.body.appeal.status).toBe('PENDING_CORRECTION'));

    const correctionReplay = await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/corrections`)
      .send({
        reviewerId: 'caseworker-1',
        requestComment: '请补充近一周护理记录与影像材料',
        dueDate: '2099-01-01',
        idempotencyKey: 'appeal-uphold-correction',
      })
      .expect(201);
    expect(correctionReplay.body.replayed).toBe(true);

    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/supplements`)
      .send({
        familyRequester: '张家属',
        comment: '补交护理记录',
        materials: materials('supplement-uphold'),
        idempotencyKey: 'appeal-uphold-supplement',
      })
      .expect(201)
      .expect((r) => expect(r.body.appeal.status).toBe('PENDING_RULING'));

    const ruling = await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'manager-li',
        comment: '补充材料不足以改变原评分，裁决维持轻度',
        idempotencyKey: 'appeal-uphold-ruling',
      })
      .expect(201);
    expect(ruling.body.appeal.status).toBe('UPHELD');
    expect(ruling.body.appeal.ruledGrade).toBe(GradeCode.LIGHT);
    expect(ruling.body.appeal.resultGradeVersionId).toBeNull();

    const rulingReplay = await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'manager-li',
        comment: '补充材料不足以改变原评分，裁决维持轻度',
        idempotencyKey: 'appeal-uphold-ruling',
      })
      .expect(201);
    expect(rulingReplay.body.replayed).toBe(true);

    const differentLateRuling = await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'manager-li',
        comment: '迟到且内容不同的裁决不得生效',
        effectiveDate: '2024-07-01',
      })
      .expect(409);
    expect(differentLateRuling.body.code).toBe('APPEAL_ALREADY_RULED');

    const afterCase = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(afterCase.body.review.id).toBe(originalReview.id);
    expect(afterCase.body.review.comment).toBe(originalReview.comment);
    expect(afterCase.body.currentGradeVersion.versionNumber).toBe(1);

    const history = await http.get(`/api/assessments/${caseId}/appeals`).expect(200);
    const saved = history.body[0];
    expect(saved.events.map((e: any) => e.eventType)).toEqual([
      'SUBMITTED',
      'CORRECTION_REQUESTED',
      'SUPPLEMENTED',
      'RULED_UPHELD',
    ]);
    expect(saved.materials).toHaveLength(2);
    expect(afterCase.body.notifications.length).toBe(3);
    expect(afterCase.body.notifications[2].status).toBe('PENDING');
    expect(afterCase.body.notifications[2].gradeVersionId).toBe(
      beforeCase.body.currentGradeVersionId,
    );
  });

  it('补正后裁决变更等级：追加新版本、按生效日切期间并生成前后费用差异', async () => {
    const { caseId, notificationId } = await createConfirmedCase(
      'APPEAL-CHANGE',
      GradeCode.LIGHT,
    );
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-01-01' })
      .expect(201);

    const appeal = await submitAppeal(caseId, notificationId);
    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/corrections`)
      .send({ reviewerId: 'caseworker-2', requestComment: '请补充医院材料', dueDate: '2099-01-01' })
      .expect(201);
    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/supplements`)
      .send({
        familyRequester: '张家属',
        comment: '已补交诊断与照护记录',
        materials: materials('supplement-change'),
      })
      .expect(201);

    const ruling = await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'manager-zhao',
        comment: '补正材料证明多项活动完全依赖，变更为重度',
        effectiveDate: '2024-03-10',
        feeImpactTo: '2024-03-12',
      })
      .expect(201);

    expect(ruling.body.appeal.status).toBe('CHANGED');
    expect(ruling.body.appeal.resultGradeVersionId).not.toBeNull();
    expect(ruling.body.appeal.feeBeforeAmount).toBe('300.00'); // LIGHT 100 * 3
    expect(ruling.body.appeal.feeAfterAmount).toBe('900.00'); // SEVERE 300 * 3
    expect(ruling.body.appeal.feeDeltaAmount).toBe('600.00');
    expect(ruling.body.period.startDate).toBe('2024-03-10');
    expect(ruling.body.period.grade).toBe(GradeCode.SEVERE);

    const impact = await http
      .get(`/api/assessments/${caseId}/appeals/${appeal.id}/fee-impact`)
      .query({ from: '2024-03-10', to: '2024-03-12' })
      .expect(200);
    expect(impact.body.delta).toBe('600.00');

    const segments = await http
      .get('/api/fees/segments')
      .query({ elderId: 'APPEAL-CHANGE', from: '2024-03-09', to: '2024-03-10' })
      .expect(200);
    expect(segments.body.segments).toMatchObject([
      { grade: GradeCode.LIGHT, days: 1, amount: '100.00' },
      { grade: GradeCode.SEVERE, days: 1, amount: '300.00' },
    ]);

    const versions = await ds.query(
      `SELECT version_number, grade, source FROM grade_versions
        WHERE assessment_case_id = $1 ORDER BY version_number`,
      [caseId],
    );
    expect(versions).toHaveLength(2);
    expect(versions.map((v: any) => v.grade)).toEqual([GradeCode.LIGHT, GradeCode.SEVERE]);
  });

  it('送达失败或超过期限：拒绝受理，不创建申诉、不改变评估/等级', async () => {
    const failedCreated = await http
      .post('/api/assessments')
      .send(payload('APPEAL-FAILED', answers(), answers(), '138-FAIL'))
      .expect(201);
    await http
      .post(`/api/assessments/${failedCreated.body.id}/notification/attempt`)
      .send({})
      .expect(201);

    const failedList = await http
      .get(`/api/assessments/${failedCreated.body.id}/notification`)
      .expect(200);
    const failedNotification = failedList.body.find((n: any) => n.status === 'FAILED');
    const failed = await http
      .post(`/api/assessments/${failedCreated.body.id}/appeals`)
      .send({
        notificationId: failedNotification.id,
        familyRequester: '张家属',
        reason: '送达失败不应能申诉',
        materials: materials('failed'),
      })
      .expect(422);
    expect(failed.body.code).toBe('NOTIFICATION_NOT_DELIVERED');

    const { caseId, notificationId } = await createConfirmedCase('APPEAL-LATE', GradeCode.LIGHT);
    await ds.query(
      `UPDATE notification_records
          SET delivered_at = now() - interval '30 days', last_attempt_at = now() - interval '30 days'
        WHERE id = $1`,
      [notificationId],
    );
    const late = await http
      .post(`/api/assessments/${caseId}/appeals`)
      .send({
        notificationId,
        familyRequester: '张家属',
        reason: '超过期限才提交',
        materials: materials('late'),
      })
      .expect(422);
    expect(late.body.code).toBe('APPEAL_DEADLINE_PASSED');

    const appeals = await ds.query(`SELECT id FROM appeals WHERE assessment_case_id = $1`, [caseId]);
    expect(appeals).toHaveLength(0);
    const assessment = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(assessment.body.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(assessment.body.review.comment).toContain('完整意见');
  });

  it('撤回后的迟到裁决不能生效；撤回/补正乱序请求幂等', async () => {
    const { caseId, notificationId } = await createConfirmedCase(
      'APPEAL-WITHDRAW',
      GradeCode.LIGHT,
    );
    const appeal = await submitAppeal(caseId, notificationId);

    const withdrawBody = {
      familyRequester: '张家属',
      reason: '家属决定先线下沟通',
      idempotencyKey: 'appeal-withdraw',
    };
    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/withdraw`)
      .send(withdrawBody)
      .expect(201)
      .expect((r) => expect(r.body.appeal.status).toBe('WITHDRAWN'));
    const withdrawReplay = await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/withdraw`)
      .send(withdrawBody)
      .expect(201);
    expect(withdrawReplay.body.replayed).toBe(true);

    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/supplements`)
      .send({
        familyRequester: '张家属',
        comment: '撤回后迟到补正',
        materials: materials('late-supplement'),
      })
      .expect(409);

    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'manager-late',
        comment: '撤回后迟到裁决，不允许生效',
        effectiveDate: '2024-05-01',
      })
      .expect(409);

    const saved = await http
      .get(`/api/assessments/${caseId}/appeals/${appeal.id}`)
      .expect(200);
    expect(saved.body.status).toBe('WITHDRAWN');
    expect(saved.body.resultGradeVersionId).toBeNull();
    const afterCase = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(afterCase.body.confirmedGrade).toBe(GradeCode.LIGHT);
  });

  it('两个管理员并发裁决：仅一个成功，不产生两条有效等级', async () => {
    const { caseId, notificationId } = await createConfirmedCase(
      'APPEAL-CONCURRENT',
      GradeCode.LIGHT,
    );
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-01-01' })
      .expect(201);
    const appeal = await submitAppeal(caseId, notificationId);

    const [r1, r2] = await Promise.all([
      http
        .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
        .send({
          confirmedGrade: GradeCode.SEVERE,
          reviewerId: 'manager-concurrent-1',
          comment: '管理员一裁决重度',
          effectiveDate: '2024-06-01',
        }),
      http
        .post(`/api/assessments/${caseId}/appeals/${appeal.id}/ruling`)
        .send({
          confirmedGrade: GradeCode.SEVERE,
          reviewerId: 'manager-concurrent-2',
          comment: '管理员二也裁决重度但为重复乱序请求',
          effectiveDate: '2024-06-01',
        }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = r1.status === 201 ? r1.body : r2.body;
    expect(winner.appeal.status).toBe('CHANGED');

    const periods = await ds.query(
      `SELECT id, grade, start_date::text AS start_date, end_date_exclusive::text AS end_date
         FROM grade_periods WHERE elder_id = $1 ORDER BY start_date`,
      ['APPEAL-CONCURRENT'],
    );
    expect(periods.filter((p: any) => p.start_date <= '2024-06-01')).toHaveLength(2);
    expect(periods[periods.length - 1].start_date).toBe('2024-06-01');
    const sameDay = periods.filter((p: any) => p.start_date === '2024-06-01');
    expect(sameDay).toHaveLength(1);

    const versions = await ds.query(
      `SELECT COUNT(*)::int AS count FROM grade_versions WHERE assessment_case_id = $1`,
      [caseId],
    );
    expect(versions[0].count).toBe(2);
  });

  it('重启应用后证据、决定、等级期间和既有告知链仍可完整复核', async () => {
    const { caseId, notificationId } = await createConfirmedCase('APPEAL-RESTART', GradeCode.LIGHT);
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-01-01' })
      .expect(201);
    const appeal = await submitAppeal(caseId, notificationId);
    await http
      .post(`/api/assessments/${caseId}/appeals/${appeal.id}/withdraw`)
      .send({ familyRequester: '张家属', reason: '重启留痕验证' })
      .expect(201);

    await app.close();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());

    const persisted = await http
      .get(`/api/assessments/${caseId}/appeals/${appeal.id}`)
      .expect(200);
    expect(persisted.body.status).toBe('WITHDRAWN');
    expect(persisted.body.gradeSnapshot.review.comment).toContain('完整意见');
    expect(persisted.body.answersSnapshot.rows.length).toBeGreaterThan(0);
    expect(persisted.body.deliverySnapshot.notificationId).toBe(notificationId);
    expect(persisted.body.events.map((e: any) => e.eventType)).toEqual(['SUBMITTED', 'WITHDRAWN']);

    const assessment = await http.get(`/api/assessments/${caseId}`).expect(200);
    expect(assessment.body.notifications.map((n: any) => n.id)).toContain(notificationId);
    expect(assessment.body.currentGradeVersion.id).toBe(persisted.body.boundGradeVersionId);
    const restartPeriods = await app.get(DataSource).query(
      `SELECT grade, start_date::text AS start_date, grade_version_id
         FROM grade_periods WHERE elder_id = $1`,
      ['APPEAL-RESTART'],
    );
    expect(restartPeriods).toMatchObject([
      {
        grade: GradeCode.LIGHT,
        start_date: '2024-01-01',
        grade_version_id: persisted.body.boundGradeVersionId,
      },
    ]);
    const migrations = await app.get(DataSource).query(`SELECT version FROM schema_migrations`);
    expect(migrations.map((m: any) => m.version)).toContain('001_appeal_workflow');
  });
});
