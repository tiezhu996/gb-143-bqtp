import { PoolClient } from 'pg';
import {
  ApiResponse,
  CreditScoreResult,
  RecoveryPlan,
  RecoveryPlanFailureReason,
  RecoveryPlanSettlement,
  RecoveryServiceResult,
  ServiceRecord,
  Volunteer,
} from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadgesInTx } from './badgeService';
import {
  CREDIT_LIMIT_THRESHOLD,
  logCreditChangeInTx,
  recalculateCreditScoreInTx,
} from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

type PlanOutcome = {
  plan: RecoveryPlan;
  settlement: RecoveryPlanSettlement | null;
};

/**
 * 在给定事务中结算已到期的观察期。
 * 仅当计划处于 active 且截止时间已到时执行，天然只生效一次。
 */
const settleDuePlanInTx = async (
  client: PoolClient,
  plan: RecoveryPlan,
  settledBy: string
): Promise<RecoveryPlanSettlement> => {
  const hoursResult = await client.query(
    `SELECT COALESCE(SUM(duration_hours), 0) AS hours
       FROM service_records
      WHERE recovery_plan_id = $1 AND is_no_show = false`,
    [plan.id]
  );
  const completedHours = parseFloat(hoursResult.rows[0].hours);
  const targetHours = parseFloat(String(plan.target_hours));
  const succeeded = completedHours >= targetHours;

  const status = succeeded ? 'succeeded' : 'failed';
  const failureReason: RecoveryPlanFailureReason | null = succeeded ? null : 'deadline_missed';

  const updateResult = await client.query(
    `UPDATE recovery_plans
        SET status = $1,
            completed_hours = $2,
            failure_reason = $3,
            settled_at = CURRENT_TIMESTAMP,
            settled_by = $4
      WHERE id = $5 AND status = 'active'
      RETURNING *`,
    [status, completedHours, failureReason, settledBy, plan.id]
  );
  const settledPlan = updateResult.rows[0] as RecoveryPlan;

  // 达标才解除接单限制；未完成保持限制。
  await client.query(
    'UPDATE volunteers SET order_restricted = $1 WHERE id = $2',
    [!succeeded, plan.volunteer_id]
  );

  // 按最新记录重算信用分（与结算同一事务）。
  const creditResult = await recalculateCreditScoreInTx(client, plan.volunteer_id);
  const creditScore = creditResult ? creditResult.afterScore : 0;

  if (creditResult && creditResult.changeAmount !== 0) {
    await logCreditChangeInTx(
      client,
      plan.volunteer_id,
      creditResult.changeAmount,
      succeeded ? '观察期达标结算-信用分重算' : '观察期到期未完成-信用分重算',
      creditResult.beforeScore,
      creditResult.afterScore,
      plan.id,
      'recovery_plan'
    );
  }

  await client.query(
    `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
     VALUES ($1, $2, 'recovery_plan', $3, $4, $5, $6)`,
    [
      settledBy,
      succeeded ? 'recovery_plan_succeed' : 'recovery_plan_fail_deadline',
      plan.id,
      { status: 'active', completed_hours: parseFloat(String(plan.completed_hours)) },
      { status, completed_hours: completedHours, credit_score: creditScore, order_restricted: !succeeded },
      succeeded ? messages.recoveryPlans.planSucceeded : messages.recoveryPlans.planFailedDeadline,
    ]
  );

  return {
    plan: settledPlan,
    succeeded,
    completedHours,
    targetHours,
    orderRestricted: !succeeded,
    creditScore,
    reason: failureReason,
  };
};

/**
 * 读取志愿者当前进行中的计划（行锁），如已到期则先在事务内结算。
 * 必须在事务中调用。
 */
export const loadActivePlanInTx = async (
  client: PoolClient,
  volunteerId: string,
  settledBy: string
): Promise<PlanOutcome> => {
  const planResult = await client.query(
    `SELECT * FROM recovery_plans
      WHERE volunteer_id = $1 AND status = 'active'
      FOR UPDATE`,
    [volunteerId]
  );

  if (planResult.rows.length === 0) {
    return { plan: null as unknown as RecoveryPlan, settlement: null };
  }

  const plan = planResult.rows[0] as RecoveryPlan;

  if (new Date(plan.deadline).getTime() <= Date.now()) {
    const settlement = await settleDuePlanInTx(client, plan, settledBy);
    return { plan: settlement.plan, settlement };
  }

  return { plan, settlement: null };
};

/**
 * 使进行中的观察期立即失效（已成立投诉 / 爽约）。
 * 已失效/已结算的计划会被跳过，保证只生效一次。
 */
export const invalidateActivePlanInTx = async (
  client: PoolClient,
  volunteerId: string,
  reason: 'complaint_upheld' | 'no_show',
  adminId: string,
  relatedRecordId?: string
): Promise<{ plan: RecoveryPlan | null; creditResult: CreditScoreResult | null }> => {
  const planResult = await client.query(
    `SELECT * FROM recovery_plans
      WHERE volunteer_id = $1 AND status = 'active'
      FOR UPDATE`,
    [volunteerId]
  );

  if (planResult.rows.length === 0) {
    return { plan: null, creditResult: null };
  }

  const plan = planResult.rows[0] as RecoveryPlan;

  const updatedResult = await client.query(
    `UPDATE recovery_plans
        SET status = 'failed', failure_reason = $1, settled_at = CURRENT_TIMESTAMP, settled_by = $2
      WHERE id = $3 AND status = 'active'
      RETURNING *`,
    [reason, adminId, plan.id]
  );
  const failedPlan = updatedResult.rows[0] as RecoveryPlan;

  // 失效后接单限制继续保持。
  await client.query(
    'UPDATE volunteers SET order_restricted = true WHERE id = $1',
    [volunteerId]
  );

  // 按最新记录重算信用分（与失效同一事务）。
  const creditResult = await recalculateCreditScoreInTx(client, volunteerId);

  if (creditResult && creditResult.changeAmount !== 0) {
    await logCreditChangeInTx(
      client,
      volunteerId,
      creditResult.changeAmount,
      reason === 'no_show' ? '爽约-恢复计划失效并信用分重算' : '已成立投诉-恢复计划失效并信用分重算',
      creditResult.beforeScore,
      creditResult.afterScore,
      plan.id,
      'recovery_plan'
    );
  }

  await client.query(
    `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
     VALUES ($1, $2, 'recovery_plan', $3, $4, $5, $6)`,
    [
      adminId,
      reason === 'no_show' ? 'recovery_plan_fail_no_show' : 'recovery_plan_fail_complaint',
      plan.id,
      { status: 'active' },
      {
        status: 'failed',
        failure_reason: reason,
        related_record_id: relatedRecordId || null,
        credit_score: creditResult ? creditResult.afterScore : null,
        order_restricted: true,
      },
      reason === 'no_show'
        ? messages.recoveryPlans.planFailedNoShow
        : messages.recoveryPlans.planFailedComplaint,
    ]
  );

  return { plan: failedPlan, creditResult };
};

export const createRecoveryPlan = async (
  volunteerId: string,
  targetHours: number,
  deadline: Date,
  adminId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [volunteerId]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;

    // 信用低于30才能创建（使用最新信用分）。
    if (volunteer.credit_score >= CREDIT_LIMIT_THRESHOLD) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.recoveryPlans.creditNotLowEnough,
        details: {
          credit_score: volunteer.credit_score,
          credit_limit_threshold: CREDIT_LIMIT_THRESHOLD,
        },
      };
    }

    // 同一志愿者同一时间只能有一份进行中的计划。
    const existingResult = await client.query(
      `SELECT id FROM recovery_plans WHERE volunteer_id = $1 AND status = 'active' FOR UPDATE`,
      [volunteerId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.activePlanExists };
    }

    const insertResult = await client.query(
      `INSERT INTO recovery_plans (volunteer_id, target_hours, deadline, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [volunteerId, targetHours, deadline.toISOString(), adminId]
    );
    const plan = insertResult.rows[0] as RecoveryPlan;

    // 计划生效期间接单限制保持，普通服务记录仍会被拒绝。
    await client.query(
      'UPDATE volunteers SET order_restricted = true WHERE id = $1',
      [volunteerId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, 'create_recovery_plan', 'recovery_plan', $2, $3, $4)`,
      [
        adminId,
        plan.id,
        {
          volunteer_id: volunteerId,
          target_hours: targetHours,
          deadline: deadline.toISOString(),
          credit_score: volunteer.credit_score,
        },
        messages.recoveryPlans.planCreated,
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.recoveryPlans.planCreated,
      data: { plan, order_restricted: true },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    // 并发下部分唯一索引兜底：重复创建不会留下半成品。
    if (error instanceof Error && /uq_recovery_plans_one_active_per_volunteer/.test(error.message)) {
      return { success: false, error: messages.recoveryPlans.activePlanExists };
    }
    logger.error(messages.logs.createRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.createFailed };
  } finally {
    client.release();
  }
};

export const getRecoveryPlanById = async (
  planId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const planResult = await client.query(
      'SELECT * FROM recovery_plans WHERE id = $1 FOR UPDATE',
      [planId]
    );

    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    let plan = planResult.rows[0] as RecoveryPlan;
    let settlement: RecoveryPlanSettlement | null = null;

    if (plan.status === 'active' && new Date(plan.deadline).getTime() <= Date.now()) {
      settlement = await settleDuePlanInTx(client, plan, 'system');
      plan = settlement.plan;
    }

    await client.query('COMMIT');

    return { success: true, data: settlement ?? { plan } };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.settleRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.getFailed };
  } finally {
    client.release();
  }
};

export const getActiveRecoveryPlan = async (
  volunteerId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { plan, settlement } = await loadActivePlanInTx(client, volunteerId, 'system');

    if (!plan) {
      await client.query('COMMIT');
      return { success: true, data: { plan: null } };
    }

    await client.query('COMMIT');

    return {
      success: true,
      data: { plan, auto_settlement: settlement },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.settleRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.getFailed };
  } finally {
    client.release();
  }
};

export const getRecoveryPlans = async (
  page: number = 1,
  pageSize: number = 20,
  status?: string,
  volunteerId?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    let query = 'SELECT * FROM recovery_plans WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM recovery_plans WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      countQuery += ` AND status = $${paramIndex}`;
      params.push(status);
      countParams.push(status);
      paramIndex++;
    }

    if (volunteerId) {
      query += ` AND volunteer_id = $${paramIndex}`;
      countQuery += ` AND volunteer_id = $${paramIndex}`;
      params.push(volunteerId);
      countParams.push(volunteerId);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const countResult = await client.query(countQuery, countParams);

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, offset);

    const result = await client.query(query, params);

    return {
      success: true,
      data: {
        plans: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const settleRecoveryPlan = async (
  planId: string,
  adminId: string
): Promise<ApiResponse<RecoveryPlanSettlement>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const planResult = await client.query(
      'SELECT * FROM recovery_plans WHERE id = $1 FOR UPDATE',
      [planId]
    );

    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    const plan = planResult.rows[0] as RecoveryPlan;

    // 已结算（成功/失败）：结算只能生效一次，重复调用幂等返回。
    if (plan.status !== 'active') {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.recoveryPlans.alreadySettled,
        data: { plan } as unknown as RecoveryPlanSettlement,
      };
    }

    // 未到截止日期不能提前结算。
    if (new Date(plan.deadline).getTime() > Date.now()) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.deadlineNotReached };
    }

    const settlement = await settleDuePlanInTx(client, plan, adminId);

    await client.query('COMMIT');

    return {
      success: true,
      message: settlement.succeeded
        ? messages.recoveryPlans.planSucceeded
        : messages.recoveryPlans.planFailedDeadline,
      data: settlement,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.settleRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.settleFailed };
  } finally {
    client.release();
  }
};

const findRecordByIdempotencyKey = async (
  client: PoolClient,
  key: string
): Promise<ServiceRecord | null> => {
  const result = await client.query(
    'SELECT * FROM service_records WHERE idempotency_key = $1',
    [key]
  );
  return result.rows.length > 0 ? (result.rows[0] as ServiceRecord) : null;
};

/**
 * 管理员登记计划内恢复服务（完成的服务，非爽约）。
 * 进度更新只能生效一次：通过 idempotency_key 唯一约束保证。
 */
export const registerRecoveryService = async (
  planId: string,
  record: Omit<ServiceRecord, 'volunteer_id'>,
  adminId: string
): Promise<ApiResponse<RecoveryServiceResult>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (record.idempotency_key) {
      const existing = await findRecordByIdempotencyKey(client, record.idempotency_key);
      if (existing) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: messages.recoveryPlans.idempotencyKeyRepeated,
          details: { record_id: existing.id },
        };
      }
    }

    const planResult = await client.query(
      'SELECT * FROM recovery_plans WHERE id = $1 FOR UPDATE',
      [planId]
    );

    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    let plan = planResult.rows[0] as RecoveryPlan;

    if (plan.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notActive, data: { plan } as any };
    }

    // 已到期：先结算（只生效一次），之后拒绝新登记。
    if (new Date(plan.deadline).getTime() <= Date.now()) {
      const settlement = await settleDuePlanInTx(client, plan, adminId);
      await client.query('COMMIT');
      return {
        success: false,
        error: settlement.succeeded
          ? messages.recoveryPlans.expiredAndSettled
          : messages.recoveryPlans.planFailedDeadline,
        data: { plan: settlement.plan } as any,
      };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [plan.volunteer_id]
    );
    const volunteer = volunteerResult.rows[0] as Volunteer;

    const pointsEarned = calculatePoints(
      record.duration_hours,
      record.service_type,
      record.rating
    );

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show,
        location, description, recovery_plan_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9)
       RETURNING *`,
      [
        plan.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        pointsEarned,
        record.location ?? null,
        record.description ?? null,
        plan.id,
        record.idempotency_key ?? null,
      ]
    );
    const newRecord = insertResult.rows[0] as ServiceRecord;

    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsEarned);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
          SET total_points = $1, level = $2, service_count = service_count + 1
        WHERE id = $3`,
      [newTotalPoints, newLevel, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'recovery_service')`,
      [
        volunteer.id,
        pointsEarned,
        `恢复计划内服务: ${record.service_type}`,
        oldTotalPoints,
        newTotalPoints,
        newRecord.id,
      ]
    );

    // 计划进度累加（只增、仅非爽约）。
    const completedHours = Math.round(
      (parseFloat(String(plan.completed_hours)) + Number(record.duration_hours)) * 100
    ) / 100;
    const targetHours = parseFloat(String(plan.target_hours));
    const targetReached = completedHours >= targetHours;

    const updatedPlanResult = await client.query(
      'UPDATE recovery_plans SET completed_hours = $1 WHERE id = $2 RETURNING *',
      [completedHours, plan.id]
    );
    plan = updatedPlanResult.rows[0] as RecoveryPlan;

    let newBadges: any[] = [];
    if (newLevel > oldLevel) {
      const currentBadges = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1',
        [volunteer.id]
      );
      newBadges = await checkNewBadgesInTx(client, volunteer.id, newLevel, currentBadges.rows);
    }

    // 按最新记录重算信用分；观察期未截止前接单限制保持不变。
    const creditResult = await recalculateCreditScoreInTx(client, volunteer.id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChangeInTx(
        client,
        volunteer.id,
        creditResult.changeAmount,
        `恢复计划内服务-信用分重算: ${record.service_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        newRecord.id,
        'recovery_service'
      );
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, 'register_recovery_service', 'recovery_plan', $2, $3, $4)`,
      [
        adminId,
        plan.id,
        {
          volunteer_id: volunteer.id,
          record_id: newRecord.id,
          duration_hours: record.duration_hours,
          completed_hours: completedHours,
          target_hours: targetHours,
        },
        messages.recoveryPlans.serviceRegistered,
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.recoveryPlans.serviceRegistered,
      data: {
        record: newRecord,
        plan,
        pointsChange: pointsEarned,
        newTotalPoints,
        newLevel,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        completedHours,
        remainingHours: Math.max(0, Math.round((targetHours - completedHours) * 100) / 100),
        targetReached,
        newBadges,
        levelUp: newLevel > oldLevel,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    // 并发重复提交：唯一索引兜底，不产生半更新。
    if (error instanceof Error && /service_records_idempotency_key/.test(error.message)) {
      return { success: false, error: messages.recoveryPlans.idempotencyKeyRepeated };
    }
    logger.error(messages.logs.registerRecoveryServiceFailed, error);
    return { success: false, error: messages.recoveryPlans.registerServiceFailed };
  } finally {
    client.release();
  }
};

/**
 * 管理员登记观察期内的爽约：记录爽约、扣积分，计划立即失效，
 * 并按最新记录重算信用分；整个过程同一事务。
 */
export const registerRecoveryNoShow = async (
  planId: string,
  record: Omit<ServiceRecord, 'volunteer_id'>,
  adminId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (record.idempotency_key) {
      const existing = await findRecordByIdempotencyKey(client, record.idempotency_key);
      if (existing) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: messages.recoveryPlans.idempotencyKeyRepeated,
          details: { record_id: existing.id },
        };
      }
    }

    const planResult = await client.query(
      'SELECT * FROM recovery_plans WHERE id = $1 FOR UPDATE',
      [planId]
    );

    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    let plan = planResult.rows[0] as RecoveryPlan;

    if (plan.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notActive, data: { plan } as any };
    }

    // 已到期先结算；爽约不会再登记到已结束的计划。
    if (new Date(plan.deadline).getTime() <= Date.now()) {
      const settlement = await settleDuePlanInTx(client, plan, adminId);
      await client.query('COMMIT');
      return {
        success: false,
        error: settlement.succeeded
          ? messages.recoveryPlans.expiredAndSettled
          : messages.recoveryPlans.planFailedDeadline,
        data: { plan: settlement.plan } as any,
      };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [plan.volunteer_id]
    );
    const volunteer = volunteerResult.rows[0] as Volunteer;

    const noShowPenalty = calculateNoShowPenalty();

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show,
        location, description, recovery_plan_id, idempotency_key)
       VALUES ($1, $2, $3, $4, 0, true, $5, $6, $7, $8)
       RETURNING *`,
      [
        plan.volunteer_id,
        record.service_type,
        record.duration_hours ?? 0,
        record.rating,
        record.location ?? null,
        record.description ?? null,
        plan.id,
        record.idempotency_key ?? null,
      ]
    );
    const newRecord = insertResult.rows[0] as ServiceRecord;

    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints - noShowPenalty);
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers SET total_points = $1, level = $2 WHERE id = $3`,
      [newTotalPoints, newLevel, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'recovery_no_show')`,
      [
        volunteer.id,
        -noShowPenalty,
        '恢复计划内爽约扣分',
        oldTotalPoints,
        newTotalPoints,
        newRecord.id,
      ]
    );

    // 爽约：计划立即失效（内部会保持接单限制并重算信用分，同事务）。
    const invalidation = await invalidateActivePlanInTx(
      client,
      volunteer.id,
      'no_show',
      adminId,
      newRecord.id
    );
    if (invalidation.plan) {
      plan = invalidation.plan;
    }

    // 失效流程已重算信用分，取最新志愿者状态返回。
    const updatedVolunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteer.id]
    );
    const updatedVolunteer = updatedVolunteerResult.rows[0] as Volunteer;

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.recoveryPlans.noShowRegistered,
      data: {
        record: newRecord,
        plan,
        pointsChange: -noShowPenalty,
        newTotalPoints,
        newLevel,
        creditScore: updatedVolunteer.credit_score,
        orderRestricted: updatedVolunteer.order_restricted,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof Error && /service_records_idempotency_key/.test(error.message)) {
      return { success: false, error: messages.recoveryPlans.idempotencyKeyRepeated };
    }
    logger.error(messages.logs.invalidateRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.registerServiceFailed };
  } finally {
    client.release();
  }
};
