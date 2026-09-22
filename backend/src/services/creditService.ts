import { PoolClient } from 'pg';
import { Volunteer, ServiceRecord, Complaint, CreditScoreResult } from '../types';
import pool from '../db/pool';

const MIN_CREDIT_SCORE = 0;
const MAX_CREDIT_SCORE = 120;
const CREDIT_LIMIT_THRESHOLD = 30;

export const calculateCreditScore = (
  volunteer: Volunteer,
  recentServices: ServiceRecord[],
  recentComplaints: Complaint[],
  noShowCount: number
): number => {
  let score = 100;

  const serviceBonus = Math.min(volunteer.service_count * 0.5, 10);
  score += serviceBonus;

  if (recentServices.length > 0) {
    const avgRating = recentServices.reduce((sum, s) => sum + s.rating, 0) / recentServices.length;
    const ratingBonus = (avgRating - 3) * 15;
    score += ratingBonus;
  }

  score -= noShowCount * 20;

  const unresolvedComplaints = recentComplaints.filter(c => c.status === 'pending' || c.status === 'resolved').length;
  score -= unresolvedComplaints * 15;

  return Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, Math.round(score)));
};

interface ScoreComputation {
  beforeScore: number;
  afterScore: number;
  changeAmount: number;
  breakdown: CreditScoreResult['breakdown'];
}

const computeCreditScore = (
  volunteer: Volunteer,
  recentServices: ServiceRecord[],
  recentComplaints: Complaint[],
  noShowCount: number
): ScoreComputation => {
  const beforeScore = volunteer.credit_score;

  let score = 100;

  const serviceCountBonus = Math.min(volunteer.service_count * 0.5, 10);
  score += serviceCountBonus;

  let averageRating = 0;
  if (recentServices.length > 0) {
    averageRating = recentServices.reduce((sum, s) => sum + s.rating, 0) / recentServices.length;
    const ratingBonus = (averageRating - 3) * 15;
    score += ratingBonus;
  }

  score -= noShowCount * 20;

  const activeComplaintCount = recentComplaints.length;
  score -= activeComplaintCount * 15;

  const afterScore = Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, Math.round(score)));
  const changeAmount = afterScore - beforeScore;

  const breakdown = {
    baseScore: 100,
    serviceCountBonus: Math.min(volunteer.service_count * 0.5, 10),
    ratingBonus: recentServices.length > 0 ? (averageRating - 3) * 15 : 0,
    noShowPenalty: -noShowCount * 20,
    complaintPenalty: -activeComplaintCount * 15,
    total: afterScore,
    details: {
      serviceCount: volunteer.service_count,
      serviceCountBonus: Math.min(volunteer.service_count * 0.5, 10),
      avgRating: recentServices.length > 0 ? Math.round(averageRating * 100) / 100 : null,
      ratingBonus: recentServices.length > 0 ? (averageRating - 3) * 15 : 0,
      noShowCount,
      noShowPenalty: -noShowCount * 20,
      activeComplaintCount,
      complaintPenalty: -activeComplaintCount * 15,
    },
  };

  return { beforeScore, afterScore, changeAmount, breakdown };
};

/**
 * 在已有事务中重算志愿者信用分。
 *
 * 接单限制（order_restricted）的同步规则：
 * - 重算后信用分低于阈值：限制立即生效（置 true）；
 * - 重算后信用分不低于阈值：保留当前限制状态，不在此处解除。
 *   解除只允许由"恢复计划达标结算"或管理员显式调整完成，
 *   观察期进行中/失败/到期未完成时限制均继续保留。
 */
export const recalculateCreditScoreInTx = async (
  client: PoolClient,
  volunteerId: string
): Promise<CreditScoreResult | null> => {
  const volunteerResult = await client.query(
    'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
    [volunteerId]
  );

  if (volunteerResult.rows.length === 0) {
    return null;
  }

  const volunteer = volunteerResult.rows[0] as Volunteer;

  const servicesResult = await client.query(
    'SELECT * FROM service_records WHERE volunteer_id = $1 ORDER BY recorded_at DESC LIMIT 50',
    [volunteerId]
  );
  const recentServices = servicesResult.rows as ServiceRecord[];

  const complaintsResult = await client.query(
    "SELECT * FROM complaints WHERE volunteer_id = $1 AND status IN ('pending', 'resolved')",
    [volunteerId]
  );
  const recentComplaints = complaintsResult.rows as Complaint[];

  const noShowResult = await client.query(
    'SELECT COUNT(*) as count FROM service_records WHERE volunteer_id = $1 AND is_no_show = true',
    [volunteerId]
  );
  const noShowCount = parseInt(noShowResult.rows[0].count);

  const { beforeScore, afterScore, changeAmount, breakdown } = computeCreditScore(
    volunteer,
    recentServices,
    recentComplaints,
    noShowCount
  );

  let orderRestricted = volunteer.order_restricted;

  if (afterScore < CREDIT_LIMIT_THRESHOLD) {
    orderRestricted = true;
  }

  if (changeAmount !== 0 || orderRestricted !== volunteer.order_restricted) {
    await client.query(
      'UPDATE volunteers SET credit_score = $1, order_restricted = $2 WHERE id = $3',
      [afterScore, orderRestricted, volunteerId]
    );
  }

  return { beforeScore, afterScore, changeAmount, breakdown, orderRestricted };
};

export const recalculateCreditScore = async (
  volunteerId: string
): Promise<CreditScoreResult | null> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await recalculateCreditScoreInTx(client, volunteerId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const isCreditLimited = (creditScore: number): boolean => {
  return creditScore < CREDIT_LIMIT_THRESHOLD;
};

export const logCreditChangeInTx = async (
  client: PoolClient,
  volunteerId: string,
  changeAmount: number,
  reason: string,
  beforeScore: number,
  afterScore: number,
  relatedId?: string,
  relatedType?: string
): Promise<void> => {
  await client.query(
    `INSERT INTO credit_logs (volunteer_id, change_amount, reason, before_score, after_score, related_id, related_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [volunteerId, changeAmount, reason, beforeScore, afterScore, relatedId, relatedType]
  );
};

export const logCreditChange = async (
  volunteerId: string,
  changeAmount: number,
  reason: string,
  beforeScore: number,
  afterScore: number,
  relatedId?: string,
  relatedType?: string
): Promise<void> => {
  const client = await pool.connect();
  try {
    await logCreditChangeInTx(
      client,
      volunteerId,
      changeAmount,
      reason,
      beforeScore,
      afterScore,
      relatedId,
      relatedType
    );
  } finally {
    client.release();
  }
};

export { CREDIT_LIMIT_THRESHOLD, MIN_CREDIT_SCORE, MAX_CREDIT_SCORE };
