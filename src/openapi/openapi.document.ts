/**
 * 手写 OpenAPI 3.0 文档（无额外依赖，随服务暴露在 GET /api/openapi.json）。
 * 覆盖：量表 / 评估 / 复核 / 告知 / 费用 / 申诉闭环 全部接口。
 */
export function buildOpenApiDocument() {
  const errorResponse = (description: string) => ({
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
      },
    },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: '养老机构评估-复核-告知-申诉-费用 流程演示 API',
      version: '1.1.0',
      description:
        '虚构量表 DEMO_ADL 的行政流程演示（评估 → 复核 → 家属告知 → 申诉闭环 → 费用生效）。' +
        '不构成医疗诊断、护理分级依据或真实护理建议。',
    },
    servers: [{ url: '/api' }],
    tags: [
      { name: 'scales', description: '量表版本' },
      { name: 'assessments', description: '评估案件' },
      { name: 'reviews', description: '管理复核' },
      { name: 'notifications', description: '家属告知' },
      { name: 'fees', description: '费用生效与分段' },
      { name: 'appeals', description: '家属申诉闭环' },
    ],
    paths: {
      '/scales/{id}': {
        get: {
          tags: ['scales'],
          summary: '量表版本、原始条目/选项、NA 分母策略、定级阈值',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: '量表版本详情' },
            '404': errorResponse('量表不存在'),
          },
        },
      },
      '/assessments': {
        post: {
          tags: ['assessments'],
          summary: '提交两位评估员作答 → INCOMPLETE / CONFIRMED / PENDING_REVIEW',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SubmitAssessmentDto' },
              },
            },
          },
          responses: {
            '201': { description: '案件（含逐项评分来源）' },
            '400': errorResponse('作答非法（评估员/条目错误）'),
          },
        },
      },
      '/assessments/{id}': {
        get: {
          tags: ['assessments'],
          summary: '案件 + 逐项评分来源 + 复核意见 + 告知记录',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: '案件详情' },
            '404': errorResponse('案件不存在'),
          },
        },
      },
      '/assessments/{caseId}/review/confirm': {
        post: {
          tags: ['reviews'],
          summary: '管理复核确认（等级限候选内，支持幂等键回放）',
          parameters: [{ name: 'caseId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ConfirmReviewDto' },
              },
            },
          },
          responses: {
            '201': { description: '确认成功（或幂等回放）' },
            '400': errorResponse('候选外等级'),
            '409': errorResponse('重复确认 / 案件未定级'),
          },
        },
      },
      '/assessments/{caseId}/notification/attempt': {
        post: {
          tags: ['notifications'],
          summary: '发起一次家属告知尝试（失败与未确认分别记录）',
          parameters: [{ name: 'caseId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotifyAttemptDto' },
              },
            },
          },
          responses: { '201': { description: '本次告知记录' } },
        },
      },
      '/assessments/{caseId}/notification': {
        get: {
          tags: ['notifications'],
          summary: '该案件全部告知记录（失败历史、未确认尝试均保留）',
          parameters: [{ name: 'caseId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: '告知记录列表' } },
        },
      },
      '/fees/activate': {
        post: {
          tags: ['fees'],
          summary: '等级生效（必须已确认；同日不允许重叠等级）',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ActivateGradeDto' },
              },
            },
          },
          responses: {
            '201': { description: '生效成功（或幂等回放）' },
            '409': errorResponse('未确认 / 同日重叠 / 回溯重叠'),
          },
        },
      },
      '/fees/segments': {
        get: {
          tags: ['fees'],
          summary: '按天分段费用：等级期间 × 日费版本，decimal 合计',
          parameters: [
            { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          ],
          responses: {
            '200': { description: '分段明细与合计' },
            '409': errorResponse('区间非法'),
          },
        },
      },
      '/appeals': {
        post: {
          tags: ['appeals'],
          summary:
            '申诉受理：绑定当时的确认等级、量表答案与送达快照；' +
            '告知未送达或超过申诉期限拒绝受理且不污染评估；同一告知仅一条进行中申诉',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/FileAppealDto' },
              },
            },
          },
          responses: {
            '201': { description: '受理成功（SUBMITTED / PENDING_CORRECTION）或幂等回放' },
            '400': errorResponse('申诉日非法 / 早于送达日'),
            '404': errorResponse('告知记录不存在'),
            '409': errorResponse('未送达 / 超期 / 已有进行中申诉'),
          },
        },
      },
      '/appeals/{id}': {
        get: {
          tags: ['appeals'],
          summary: '申诉详情：快照、材料、裁决决定与完整留痕事件',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: '申诉详情（含 events 与 decision）' },
            '404': errorResponse('申诉不存在'),
          },
        },
      },
      '/appeals/{id}/supplement': {
        post: {
          tags: ['appeals'],
          summary: '补正：追加材料 → 待裁决（同键回放，终态拒绝，超期落 EXPIRED）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SupplementAppealDto' },
              },
            },
          },
          responses: {
            '201': { description: '补正成功（PENDING_ADJUDICATION）或幂等回放' },
            '409': errorResponse('终态 / 已过期 / 幂等键冲突'),
          },
        },
      },
      '/appeals/{id}/withdraw': {
        post: {
          tags: ['appeals'],
          summary: '撤回：进行中 → WITHDRAWN（重复撤回幂等回放）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WithdrawAppealDto' },
              },
            },
          },
          responses: {
            '201': { description: '撤回成功或幂等回放' },
            '409': errorResponse('已裁决 / 已过期'),
          },
        },
      },
      '/appeals/{id}/adjudicate': {
        post: {
          tags: ['appeals'],
          summary:
            '裁决：UPHELD 维持 / CHANGED 变更。变更追加新等级版本并按明确生效日' +
            '计算前后费用差异；不改写原复核意见；并发裁决仅一个成功',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AdjudicateAppealDto' },
              },
            },
          },
          responses: {
            '201': { description: '裁决成功（UPHELD / CHANGED）或幂等回放' },
            '400': errorResponse('变更缺新等级/生效日、维持携带等级、新等级未变化'),
            '409': errorResponse('已裁决 / 已撤回 / 已过期 / 待补正 / 生效日重叠'),
          },
        },
      },
      '/assessments/{caseId}/appeals': {
        get: {
          tags: ['appeals'],
          summary: '案件维度的申诉历史（含决定与事件链）',
          parameters: [{ name: 'caseId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: '申诉历史列表' } },
        },
      },
    },
    components: {
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            statusCode: { type: 'integer' },
            message: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              ],
            },
            error: { type: 'string' },
          },
        },
        GradeCode: {
          type: 'string',
          enum: ['LIGHT', 'MODERATE', 'SEVERE'],
        },
        AppealStatus: {
          type: 'string',
          enum: [
            'SUBMITTED',
            'PENDING_CORRECTION',
            'PENDING_ADJUDICATION',
            'UPHELD',
            'CHANGED',
            'WITHDRAWN',
            'EXPIRED',
          ],
        },
        SubmitAssessmentDto: {
          type: 'object',
          required: ['elderId', 'elderName', 'familyContact', 'assessors'],
          properties: {
            elderId: { type: 'string' },
            elderName: { type: 'string' },
            familyContact: { type: 'string' },
            scaleVersionId: { type: 'string', format: 'uuid' },
            assessors: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: {
                type: 'object',
                required: ['assessorId', 'answers'],
                properties: {
                  assessorId: { type: 'integer', enum: [1, 2] },
                  answers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['itemCode', 'optionCode'],
                      properties: {
                        itemCode: { type: 'string' },
                        optionCode: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ConfirmReviewDto: {
          type: 'object',
          required: ['confirmedGrade', 'reviewerId', 'comment'],
          properties: {
            confirmedGrade: { $ref: '#/components/schemas/GradeCode' },
            reviewerId: { type: 'string' },
            comment: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
        NotifyAttemptDto: {
          type: 'object',
          properties: {
            simulateFail: { type: 'boolean', description: '演示用：强制本次送达失败' },
          },
        },
        ActivateGradeDto: {
          type: 'object',
          required: ['caseId', 'effectiveDate'],
          properties: {
            caseId: { type: 'string', format: 'uuid' },
            effectiveDate: { type: 'string', format: 'date' },
            idempotencyKey: { type: 'string' },
          },
        },
        FileAppealDto: {
          type: 'object',
          required: ['notificationId', 'reason', 'filedBy'],
          properties: {
            notificationId: { type: 'string', format: 'uuid', description: '被异议的告知记录（须已送达）' },
            reason: { type: 'string', minLength: 5 },
            filedBy: { type: 'string', description: '申诉人（家属）标识' },
            materials: {
              type: 'array',
              items: { type: 'string' },
              description: '随申诉提交的材料；为空则进入待补正',
            },
            filedOn: { type: 'string', format: 'date', description: '业务申诉日期（演示可指定，缺省为当天）' },
            correctionDeadline: { type: 'string', format: 'date', description: '补正期限（演示参数）' },
            idempotencyKey: { type: 'string' },
          },
        },
        SupplementAppealDto: {
          type: 'object',
          required: ['materials'],
          properties: {
            materials: { type: 'array', minItems: 1, items: { type: 'string' } },
            note: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
        WithdrawAppealDto: {
          type: 'object',
          required: ['withdrawnBy'],
          properties: {
            withdrawnBy: { type: 'string' },
            reason: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
        AdjudicateAppealDto: {
          type: 'object',
          required: ['decision', 'comment', 'adjudicatorId'],
          properties: {
            decision: { type: 'string', enum: ['UPHELD', 'CHANGED'] },
            newGrade: { ...{ $ref: '#/components/schemas/GradeCode' }, description: 'CHANGED 必填，且不得等于被异议等级' },
            effectiveDate: { type: 'string', format: 'date', description: 'CHANGED 必填：新等级生效日' },
            comment: { type: 'string', minLength: 5 },
            adjudicatorId: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
      },
    },
  };
}
