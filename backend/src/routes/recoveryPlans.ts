import { Router, Response } from 'express';
import {
  validateRequest,
  validateQuery,
  createRecoveryPlanSchema,
  recoveryServiceSchema,
  recoveryNoShowSchema,
  paginationSchema,
} from '../middleware/validator';
import {
  createRecoveryPlan,
  getRecoveryPlanById,
  getRecoveryPlans,
  settleRecoveryPlan,
  registerRecoveryService,
  registerRecoveryNoShow,
} from '../services/recoveryPlanService';
import { AuthRequest } from '../middleware/auth';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

// 列表（可按状态/志愿者过滤）
router.get('/', validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const status = req.query.status as string | undefined;
    const volunteerId = req.query.volunteer_id as string | undefined;
    const result = await getRecoveryPlans(page, pageSize, status, volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting recovery plans');
  }
});

// 创建观察期
router.post('/', validateRequest(createRecoveryPlanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await createRecoveryPlan(
      req.body.volunteer_id,
      req.body.target_hours,
      new Date(req.body.deadline),
      adminId
    );
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating recovery plan');
  }
});

// 单个计划详情（到期会自动结算一次）
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getRecoveryPlanById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting recovery plan');
  }
});

// 到期结算（只能生效一次）
router.post('/:id/settle', async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await settleRecoveryPlan(req.params.id, adminId);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error settling recovery plan');
  }
});

// 管理员登记计划内恢复服务（进度更新只能生效一次）
router.post(
  '/:id/services',
  validateRequest(recoveryServiceSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const adminId = req.user?.id || 'admin';
      const result = await registerRecoveryService(req.params.id, req.body, adminId);
      const statusCode = result.success ? 201 : 400;
      res.status(statusCode).json(result);
    } catch (error) {
      sendInternalError(res, error, 'Error registering recovery service');
    }
  }
);

// 管理员登记观察期内爽约（计划立即失效）
router.post(
  '/:id/no-shows',
  validateRequest(recoveryNoShowSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const adminId = req.user?.id || 'admin';
      const result = await registerRecoveryNoShow(req.params.id, req.body, adminId);
      const statusCode = result.success ? 201 : 400;
      res.status(statusCode).json(result);
    } catch (error) {
      sendInternalError(res, error, 'Error registering recovery no-show');
    }
  }
);

export default router;
