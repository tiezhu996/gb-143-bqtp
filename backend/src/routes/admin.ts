import { Router, Response } from 'express';
import {
  validateRequest,
  validateQuery,
  adjustPointsSchema,
  adjustCreditSchema,
  paginationSchema,
  createRecoveryPlanSchema,
  recoveryServiceRecordSchema,
  recoveryPlanQuerySchema,
} from '../middleware/validator';
import {
  adjustPoints,
  adjustCreditScore,
  getAdminAuditLogs,
  setVolunteerStatus,
} from '../services/adminService';
import {
  createRecoveryPlan,
  registerRecoveryService,
  settleRecoveryPlan,
  settleDueRecoveryPlans,
  getRecoveryPlans,
  getRecoveryPlanById,
} from '../services/recoveryPlanService';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import { messages } from '../constants/messages';
import { sendBadRequest, sendInternalError } from '../utils/httpResponses';

const router = Router();

router.use(requireAdmin);

router.post('/adjust-points', validateRequest(adjustPointsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await adjustPoints(
      req.body.volunteer_id,
      req.body.points_change,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting points');
  }
});

router.post('/adjust-credit', validateRequest(adjustCreditSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await adjustCreditScore(
      req.body.volunteer_id,
      req.body.credit_change,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting credit score');
  }
});

router.get('/audit-logs', validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const adminId = req.query.admin_id as string;
    const action = req.query.action as string;
    const result = await getAdminAuditLogs(page, pageSize, adminId, action);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting audit logs');
  }
});

router.patch('/volunteers/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const isActive = req.body.is_active;
    if (typeof isActive !== 'boolean') {
      sendBadRequest(res, messages.validation.activeFlagRequired);
      return;
    }
    const adminId = req.user?.id || 'admin';
    const reason = req.body.reason || '管理员操作';
    const result = await setVolunteerStatus(req.params.id, isActive, adminId, reason);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error setting volunteer status');
  }
});

router.post('/recovery-plans', validateRequest(createRecoveryPlanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await createRecoveryPlan(
      req.body.volunteer_id,
      req.body.target_hours,
      req.body.deadline,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating recovery plan');
  }
});

router.get('/recovery-plans', validateQuery(recoveryPlanQuerySchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const volunteerId = req.query.volunteer_id as string;
    const status = req.query.status as string;
    const result = await getRecoveryPlans(page, pageSize, volunteerId, status);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting recovery plans');
  }
});

router.post('/recovery-plans/settle-due', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await settleDueRecoveryPlans(adminId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error settling due recovery plans');
  }
});

router.get('/recovery-plans/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getRecoveryPlanById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting recovery plan');
  }
});

router.post('/recovery-plans/:id/records', validateRequest(recoveryServiceRecordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await registerRecoveryService(req.params.id, req.body, adminId);
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error registering recovery service');
  }
});

router.post('/recovery-plans/:id/settle', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await settleRecoveryPlan(req.params.id, adminId);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error settling recovery plan');
  }
});

export default router;
