import { PoolClient } from 'pg';
import {
  ApiResponse,
  CreditRecoveryPlan,
  CreditScoreResult,
  ServiceRecord,
  Volunteer,
} from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadges } from './badgeService';
import {
  recalculateCreditScore,
  logCreditChange,
  isCreditLimited,
  CREDIT_LIMIT_THRESHOLD,
} from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

/**
 * 将指定志愿者生效中的恢复计划置为失效（爽约或投诉成立时调用）。
 * 必须在调用方的事务内执行，保证失效与业务变更同生共死。
 */
export const invalidateActivePlanForVolunteer = async (
  client: PoolClient,
  volunteerId: string,
  note: string
): Promise<CreditRecoveryPlan | null> => {
  const result = await client.query(
    `UPDATE credit_recovery_plans
     SET status = 'invalidated', settlement_note = $2, settled_at = CURRENT_TIMESTAMP
     WHERE volunteer_id = $1 AND status = 'active'
     RETURNING *`,
    [volunteerId, note]
  );
  return result.rows.length > 0 ? (result.rows[0] as CreditRecoveryPlan) : null;
};

export const createRecoveryPlan = async (
  volunteerId: string,
  targetHours: number,
  deadline: Date,
  adminId: string,
  reason?: string
): Promise<ApiResponse<CreditRecoveryPlan>> => {
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

    if (!isCreditLimited(volunteer.credit_score)) {
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

    if (new Date(deadline).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.invalidDeadline };
    }

    const existingResult = await client.query(
      "SELECT id FROM credit_recovery_plans WHERE volunteer_id = $1 AND status = 'active'",
      [volunteerId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.alreadyActive };
    }

    const insertResult = await client.query(
      `INSERT INTO credit_recovery_plans (volunteer_id, target_hours, deadline, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [volunteerId, targetHours, deadline, adminId]
    );

    const plan = insertResult.rows[0] as CreditRecoveryPlan;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId,
        'create_recovery_plan',
        'recovery_plan',
        plan.id,
        { volunteer_id: volunteerId, target_hours: targetHours, deadline },
        reason || '创建低信用恢复计划',
      ]
    );

    await client.query('COMMIT');

    return { success: true, data: plan };
  } catch (error) {
    await client.query('ROLLBACK');
    // 唯一部分索引兜底：并发创建时只有一个事务能成功
    if ((error as { code?: string }).code === '23505') {
      return { success: false, error: messages.recoveryPlans.alreadyActive };
    }
    logger.error(messages.logs.createRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.createFailed };
  } finally {
    client.release();
  }
};

export const registerRecoveryService = async (
  planId: string,
  record: ServiceRecord,
  adminId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const planResult = await client.query(
      'SELECT * FROM credit_recovery_plans WHERE id = $1 FOR UPDATE',
      [planId]
    );

    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    const plan = planResult.rows[0] as CreditRecoveryPlan;

    if (plan.status !== 'active') {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.recoveryPlans.notActive,
        details: { status: plan.status },
      };
    }

    if (new Date(plan.deadline).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.expiredPendingSettle };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [plan.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;
    const isNoShow = record.is_no_show || false;

    const pointsEarned = isNoShow ? 0 : calculatePoints(
      record.duration_hours,
      record.service_type,
      record.rating
    );

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show, location, description, recovery_plan_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        plan.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        pointsEarned,
        isNoShow,
        record.location,
        record.description,
        planId,
      ]
    );

    const newRecord = insertResult.rows[0];

    const pointsChange = isNoShow ? -calculateNoShowPenalty() : pointsEarned;
    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1,
           level = $2,
           service_count = service_count + $3
       WHERE id = $4`,
      [newTotalPoints, newLevel, isNoShow ? 0 : 1, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        volunteer.id,
        pointsChange,
        isNoShow ? '恢复计划内服务爽约扣分' : `恢复计划内服务积分: ${record.service_type}`,
        oldTotalPoints,
        newTotalPoints,
        newRecord.id,
        'service_record',
      ]
    );

    let newBadges: any[] = [];
    if (newLevel > oldLevel) {
      const currentBadges = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1',
        [volunteer.id]
      );
      newBadges = await checkNewBadges(volunteer.id, newLevel, currentBadges.rows);
    }

    let updatedPlan: CreditRecoveryPlan;
    if (isNoShow) {
      // 爽约：计划立即失效，时长不计入进度
      const invalidated = await invalidateActivePlanForVolunteer(
        client,
        plan.volunteer_id,
        messages.recoveryPlans.invalidatedNoShow
      );
      updatedPlan = invalidated as CreditRecoveryPlan;
    } else {
      // 进度更新与记录插入在同一事务内，且仅当计划仍生效时才生效
      const progressResult = await client.query(
        `UPDATE credit_recovery_plans
         SET completed_hours = completed_hours + $1
         WHERE id = $2 AND status = 'active'
         RETURNING *`,
        [record.duration_hours, planId]
      );
      if (progressResult.rows.length === 0) {
        throw new Error('Recovery plan is no longer active');
      }
      updatedPlan = progressResult.rows[0] as CreditRecoveryPlan;
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId,
        isNoShow ? 'recovery_service_no_show' : 'recovery_service',
        'recovery_plan',
        planId,
        {
          record_id: newRecord.id,
          duration_hours: record.duration_hours,
          completed_hours: updatedPlan.completed_hours,
          plan_status: updatedPlan.status,
        },
        isNoShow ? '计划内恢复服务爽约' : '登记计划内恢复服务',
      ]
    );

    await client.query('COMMIT');

    // 仅爽约（计划失效）时按最新记录重算信用；
    // 正常登记不重算，观察期内信用保持限制状态，待到期结算统一处理
    let creditResult: CreditScoreResult | null = null;
    if (isNoShow) {
      creditResult = await recalculateCreditScore(plan.volunteer_id);
      if (creditResult && creditResult.changeAmount !== 0) {
        await logCreditChange(
          plan.volunteer_id,
          creditResult.changeAmount,
          '恢复计划爽约-信用分重算',
          creditResult.beforeScore,
          creditResult.afterScore,
          newRecord.id,
          'service_record'
        );
      }
    }

    return {
      success: true,
      data: {
        record: newRecord,
        plan: updatedPlan,
        planInvalidated: isNoShow,
        pointsChange,
        newTotalPoints,
        newLevel,
        newBadges,
        levelUp: newLevel > oldLevel,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.registerRecoveryServiceFailed, error);
    return { success: false, error: messages.recoveryPlans.registerFailed };
  } finally {
    client.release();
  }
};

export const settleRecoveryPlan = async (
  planId: string,
  adminId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const planResult = await client.query(
      'SELECT * FROM credit_recovery_plans WHERE id = $1 FOR UPDATE',
      [planId]
    );

    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    const plan = planResult.rows[0] as CreditRecoveryPlan;

    if (plan.status !== 'active') {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.recoveryPlans.alreadySettled,
        details: { status: plan.status },
      };
    }

    if (new Date(plan.deadline).getTime() > Date.now()) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.recoveryPlans.notExpired };
    }

    const achieved = Number(plan.completed_hours) >= Number(plan.target_hours);
    const newStatus = achieved ? 'completed' : 'failed';

    const settleResult = await client.query(
      `UPDATE credit_recovery_plans
       SET status = $1, settled_at = CURRENT_TIMESTAMP, settlement_note = $2
       WHERE id = $3 AND status = 'active'
       RETURNING *`,
      [newStatus, achieved ? messages.recoveryPlans.completed : messages.recoveryPlans.failed, planId]
    );

    if (settleResult.rows.length === 0) {
      throw new Error('Recovery plan is no longer active');
    }

    const settledPlan = settleResult.rows[0] as CreditRecoveryPlan;

    // 达标才解除接单限制：信用分提升到限制线；未达标保持限制不动
    let creditLift: { beforeScore: number; afterScore: number } | null = null;
    if (achieved) {
      const volunteerResult = await client.query(
        'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
        [plan.volunteer_id]
      );

      if (volunteerResult.rows.length > 0) {
        const volunteer = volunteerResult.rows[0] as Volunteer;
        if (isCreditLimited(volunteer.credit_score)) {
          await client.query(
            'UPDATE volunteers SET credit_score = $1 WHERE id = $2',
            [CREDIT_LIMIT_THRESHOLD, volunteer.id]
          );

          await client.query(
            `INSERT INTO credit_logs (volunteer_id, change_amount, reason, before_score, after_score, related_id, related_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              volunteer.id,
              CREDIT_LIMIT_THRESHOLD - volunteer.credit_score,
              '恢复计划达标-解除接单限制',
              volunteer.credit_score,
              CREDIT_LIMIT_THRESHOLD,
              planId,
              'recovery_plan',
            ]
          );

          creditLift = { beforeScore: volunteer.credit_score, afterScore: CREDIT_LIMIT_THRESHOLD };
        }
      }
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminId,
        'settle_recovery_plan',
        'recovery_plan',
        planId,
        {
          status: newStatus,
          achieved,
          completed_hours: plan.completed_hours,
          target_hours: plan.target_hours,
          credit_lifted: creditLift !== null,
        },
        achieved ? messages.recoveryPlans.completed : messages.recoveryPlans.failed,
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: achieved ? messages.recoveryPlans.completed : messages.recoveryPlans.failed,
      data: {
        plan: settledPlan,
        achieved,
        creditLift,
        creditLimitLifted: creditLift !== null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.settleRecoveryPlanFailed, error);
    return { success: false, error: messages.recoveryPlans.settleFailed };
  } finally {
    client.release();
  }
};

export const settleDueRecoveryPlans = async (adminId: string): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const dueResult = await client.query(
      "SELECT id FROM credit_recovery_plans WHERE status = 'active' AND deadline <= CURRENT_TIMESTAMP ORDER BY deadline ASC"
    );

    const results: any[] = [];
    let settledCount = 0;

    for (const row of dueResult.rows) {
      const result = await settleRecoveryPlan(row.id, adminId);
      if (result.success) {
        settledCount++;
      }
      results.push({
        plan_id: row.id,
        success: result.success,
        message: result.message,
        error: result.error,
      });
    }

    return {
      success: true,
      data: {
        total: dueResult.rows.length,
        settledCount,
        results,
      },
    };
  } finally {
    client.release();
  }
};

export const getRecoveryPlans = async (
  page: number = 1,
  pageSize: number = 20,
  volunteerId?: string,
  status?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    let query = `
      SELECT p.*, v.name AS volunteer_name, v.credit_score
      FROM credit_recovery_plans p
      JOIN volunteers v ON v.id = p.volunteer_id
      WHERE 1=1`;
    let countQuery = 'SELECT COUNT(*) as total FROM credit_recovery_plans p WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];
    let paramIndex = 1;

    if (volunteerId) {
      query += ` AND p.volunteer_id = $${paramIndex}`;
      countQuery += ` AND p.volunteer_id = $${paramIndex}`;
      params.push(volunteerId);
      countParams.push(volunteerId);
      paramIndex++;
    }

    if (status) {
      query += ` AND p.status = $${paramIndex}`;
      countQuery += ` AND p.status = $${paramIndex}`;
      params.push(status);
      countParams.push(status);
      paramIndex++;
    }

    query += ' ORDER BY p.created_at DESC';

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

export const getRecoveryPlanById = async (planId: string): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const planResult = await client.query(
      `SELECT p.*, v.name AS volunteer_name, v.credit_score
       FROM credit_recovery_plans p
       JOIN volunteers v ON v.id = p.volunteer_id
       WHERE p.id = $1`,
      [planId]
    );

    if (planResult.rows.length === 0) {
      return { success: false, error: messages.recoveryPlans.notFound };
    }

    const recordsResult = await client.query(
      `SELECT * FROM service_records
       WHERE recovery_plan_id = $1
       ORDER BY recorded_at DESC`,
      [planId]
    );

    return {
      success: true,
      data: {
        plan: planResult.rows[0],
        records: recordsResult.rows,
      },
    };
  } finally {
    client.release();
  }
};

export const getVolunteerActiveRecoveryPlan = async (
  volunteerId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM credit_recovery_plans
       WHERE volunteer_id = $1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [volunteerId]
    );

    return {
      success: true,
      data: result.rows.length > 0 ? result.rows[0] : null,
    };
  } finally {
    client.release();
  }
};
