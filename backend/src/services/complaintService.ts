import { ApiResponse, Complaint, ComplaintWithCredit } from '../types';
import pool from '../db/pool';
import { calculateComplaintPenalty } from './pointsCalculator';
import { logCreditChangeInTx, recalculateCreditScoreInTx } from './creditService';
import { calculateLevel } from './badgeService';
import { invalidateActivePlanInTx } from './recoveryPlanService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const createComplaint = async (
  volunteerId: string,
  complaintType: string,
  description: string,
  complainantId?: string
): Promise<ApiResponse<ComplaintWithCredit>> => {
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

    const result = await client.query(
      `INSERT INTO complaints (volunteer_id, complainant_id, complaint_type, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [volunteerId, complainantId, complaintType, description]
    );

    const newComplaint = result.rows[0];

    // 待处理投诉尚未成立，不触发计划失效，仅按最新记录重算信用分。
    const creditResult = await recalculateCreditScoreInTx(client, volunteerId);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChangeInTx(
        client,
        volunteerId,
        creditResult.changeAmount,
        `投诉创建-信用分重算: ${complaintType}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        newComplaint.id,
        'complaint'
      );
    }

    await client.query('COMMIT');

    return {
      success: true,
      data: {
        ...newComplaint,
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getComplaints = async (
  page: number = 1,
  pageSize: number = 20,
  status?: string,
  volunteerId?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    let query = 'SELECT * FROM complaints WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM complaints WHERE 1=1';
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
        complaints: result.rows,
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

export const handleComplaint = async (
  complaintId: string,
  action: 'resolve' | 'reject',
  handledBy: string,
  resolution: string,
  severity: number = 1
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const complaintResult = await client.query(
      'SELECT * FROM complaints WHERE id = $1',
      [complaintId]
    );

    if (complaintResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.notFound };
    }

    const complaint = complaintResult.rows[0] as Complaint;

    if (complaint.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.alreadyHandled };
    }

    if (action === 'reject') {
      await client.query(
        `UPDATE complaints
         SET status = 'rejected', resolution = $1, handled_by = $2, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [resolution, handledBy, complaintId]
      );

      // 投诉驳回（未成立）：不触发计划失效，仅按最新记录重算信用分。
      const creditResult = await recalculateCreditScoreInTx(client, complaint.volunteer_id);
      if (creditResult && creditResult.changeAmount !== 0) {
        await logCreditChangeInTx(
          client,
          complaint.volunteer_id,
          creditResult.changeAmount,
          '投诉驳回-信用分重算',
          creditResult.beforeScore,
          creditResult.afterScore,
          complaintId,
          'complaint'
        );
      }

      await client.query('COMMIT');

      return {
        success: true,
        message: messages.complaints.rejected,
        data: creditResult ? {
          creditScore: creditResult.afterScore,
          creditChange: creditResult.changeAmount,
          creditBreakdown: creditResult.breakdown,
        } : undefined,
      };
    }

    const { creditPenalty, pointsPenalty } = calculateComplaintPenalty(
      complaint.complaint_type,
      severity
    );

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [complaint.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const newTotalPoints = Math.max(0, volunteer.total_points - pointsPenalty);
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1, level = $2
       WHERE id = $3`,
      [newTotalPoints, newLevel, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [volunteer.id, -pointsPenalty, `投诉处理扣分: ${complaint.complaint_type}`, volunteer.total_points, newTotalPoints, complaintId, 'complaint']
    );

    await client.query(
      `UPDATE complaints
       SET status = 'resolved',
           resolution = $1,
           credit_penalty = $2,
           points_penalty = $3,
           handled_by = $4,
           resolved_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [resolution, creditPenalty, pointsPenalty, handledBy, complaintId]
    );

    // 已成立投诉：若志愿者处于恢复观察期，计划立即失效，保持接单限制，
    // 并按最新记录重算信用分（与投诉处理同一事务，只生效一次）。
    const invalidation = await invalidateActivePlanInTx(
      client,
      complaint.volunteer_id,
      'complaint_upheld',
      handledBy,
      complaintId
    );

    let creditResult = invalidation.creditResult;

    // 无观察期失效时，仍需正常重算一次信用分。
    if (!invalidation.plan) {
      creditResult = await recalculateCreditScoreInTx(client, complaint.volunteer_id);
      if (creditResult && creditResult.changeAmount !== 0) {
        await logCreditChangeInTx(
          client,
          complaint.volunteer_id,
          creditResult.changeAmount,
          `投诉处理-信用分重算: ${complaint.complaint_type}`,
          creditResult.beforeScore,
          creditResult.afterScore,
          complaintId,
          'complaint'
        );
      }
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [handledBy, 'resolve_complaint', 'complaint', complaintId,
       { creditPenalty, pointsPenalty }, resolution]
    );

    await client.query('COMMIT');

    return {
      success: true,
      data: {
        message: messages.complaints.resolved,
        creditPenalty,
        pointsPenalty,
        newTotalPoints,
        newLevel,
        recoveryPlanFailed: !!invalidation.plan,
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.handleComplaintFailed, error);
    return { success: false, error: messages.complaints.handleFailed };
  } finally {
    client.release();
  }
};

export const getComplaintById = async (
  complaintId: string
): Promise<ApiResponse<Complaint>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM complaints WHERE id = $1',
      [complaintId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.complaints.notFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};
