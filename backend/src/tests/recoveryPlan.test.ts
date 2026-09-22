import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord } from '../services/volunteerService';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { adjustCreditScore } from '../services/adminService';
import { createComplaint, handleComplaint } from '../services/complaintService';
import {
  createRecoveryPlan,
  registerRecoveryService,
  settleRecoveryPlan,
  settleDueRecoveryPlans,
  getRecoveryPlanById,
  getVolunteerActiveRecoveryPlan,
} from '../services/recoveryPlanService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const futureDeadline = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const makeDeadlinePast = async (planId: string): Promise<void> => {
  await pool.query(
    "UPDATE credit_recovery_plans SET deadline = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = $1",
    [planId]
  );
};

const getPlanStatus = async (planId: string): Promise<any> => {
  const result = await pool.query('SELECT * FROM credit_recovery_plans WHERE id = $1', [planId]);
  return result.rows[0];
};

const createLowCreditVolunteer = async (name: string, phone: string): Promise<string | null> => {
  const created = await createVolunteer(name, phone, undefined);
  if (!created.success || !created.data?.id) {
    return null;
  }
  const volunteerId = created.data.id;
  await adjustCreditScore(volunteerId, -80, 'test-admin', '测试用例: 将信用分降到限制线以下');
  return volunteerId;
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  志愿者积分与信用评估系统 - 验证用例');
  console.log('  测试场景: 低信用志愿者恢复计划');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    // ---------------------------------------------------------
    console.log('\n--- 用例1: 信用未低于限制线时不能创建恢复计划 ---');
    const normalVolunteer = await createVolunteer('测试志愿者-信用正常', '13900000011', undefined);
    const normalId = normalVolunteer.data?.id as string;
    const notLowResult = await createRecoveryPlan(normalId, 4, futureDeadline(7), 'test-admin', '信用正常不应创建');
    assert('信用正常志愿者创建计划被拒绝', notLowResult.success === false, '信用未低于30应拒绝', notLowResult);
    assert('返回信用未低于限制线提示', notLowResult.error === '信用分未低于限制线，无需创建恢复计划',
      `实际错误: ${notLowResult.error}`, notLowResult);

    // ---------------------------------------------------------
    console.log('\n--- 用例2: 低信用志愿者创建计划，且同一志愿者只能有一份生效计划 ---');
    const v1 = await createLowCreditVolunteer('测试志愿者-恢复达标', '13900000012');
    assert('低信用志愿者创建成功', !!v1, '志愿者创建失败');
    if (!v1) throw new Error('无法继续测试');

    const plan1Result = await createRecoveryPlan(v1, 4, futureDeadline(7), 'test-admin', '观察期恢复计划');
    assert('恢复计划创建成功', plan1Result.success && !!plan1Result.data, '计划创建失败', plan1Result);
    const plan1Id = plan1Result.data?.id as string;
    assert('计划状态为active', plan1Result.data?.status === 'active', `实际状态: ${plan1Result.data?.status}`);
    assert('目标时长为4小时', Number(plan1Result.data?.target_hours) === 4, `实际: ${plan1Result.data?.target_hours}`);
    assert('初始进度为0', Number(plan1Result.data?.completed_hours) === 0, `实际: ${plan1Result.data?.completed_hours}`);

    const duplicateResult = await createRecoveryPlan(v1, 6, futureDeadline(7), 'test-admin', '重复创建');
    assert('重复创建被拒绝', duplicateResult.success === false, '同一志愿者只能有一份生效计划', duplicateResult);
    assert('返回已有生效计划提示', duplicateResult.error === '该志愿者已有生效中的恢复计划',
      `实际错误: ${duplicateResult.error}`, duplicateResult);

    // ---------------------------------------------------------
    console.log('\n--- 用例3: 计划生效后普通服务记录仍被拒绝 ---');
    const normalRecord = await createServiceRecord({
      volunteer_id: v1,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '计划生效期间尝试普通记录',
    });
    assert('普通服务记录仍被拒绝', normalRecord.success === false, '低信用普通记录应被拒绝', normalRecord);
    assert('拒绝原因为信用分过低', normalRecord.error === '信用分过低，无法接单',
      `实际错误: ${normalRecord.error}`, normalRecord);

    // ---------------------------------------------------------
    console.log('\n--- 用例4: 管理员登记计划内恢复服务并更新进度 ---');
    const reg1 = await registerRecoveryService(plan1Id, {
      volunteer_id: v1,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '恢复服务第一次',
    }, 'test-admin');
    assert('第一次恢复服务登记成功', reg1.success === true, '登记失败', reg1);
    assert('进度更新为2小时', Number(reg1.data?.plan?.completed_hours) === 2,
      `实际进度: ${reg1.data?.plan?.completed_hours}`, reg1.data?.plan);
    assert('恢复服务获得积分', (reg1.data?.pointsChange ?? 0) > 0, '积分应大于0', reg1.data);
    assert('记录关联到计划', reg1.data?.record?.recovery_plan_id === plan1Id,
      '服务记录应关联恢复计划', reg1.data?.record);
    assert('观察期内信用不重算保持20分', reg1.data?.creditScore === 20 && reg1.data?.creditChange === 0,
      `实际信用: ${reg1.data?.creditScore}, 变化: ${reg1.data?.creditChange}`, reg1.data);

    const reg2 = await registerRecoveryService(plan1Id, {
      volunteer_id: v1,
      service_type: 'elderly_care',
      duration_hours: 2,
      rating: 4,
      is_no_show: false,
      description: '恢复服务第二次',
    }, 'test-admin');
    assert('第二次恢复服务登记成功', reg2.success === true, '登记失败', reg2);
    assert('进度累计为4小时', Number(reg2.data?.plan?.completed_hours) === 4,
      `实际进度: ${reg2.data?.plan?.completed_hours}`, reg2.data?.plan);

    // ---------------------------------------------------------
    console.log('\n--- 用例5: 未到截止时间不能结算 ---');
    const earlySettle = await settleRecoveryPlan(plan1Id, 'test-admin');
    assert('未到期结算被拒绝', earlySettle.success === false, '未到截止时间应拒绝结算', earlySettle);
    assert('返回未到截止时间提示', earlySettle.error === '恢复计划未到截止时间，无法结算',
      `实际错误: ${earlySettle.error}`, earlySettle);

    // ---------------------------------------------------------
    console.log('\n--- 用例6: 到期达标结算，解除接单限制（结算只能生效一次） ---');
    const v1BeforeSettle = await getVolunteerById(v1);
    assert('结算前信用分保持20分（观察期内未解除限制）', v1BeforeSettle.data?.credit_score === 20,
      `实际: ${v1BeforeSettle.data?.credit_score}`, v1BeforeSettle.data);

    await makeDeadlinePast(plan1Id);
    const settle1 = await settleRecoveryPlan(plan1Id, 'test-admin');
    assert('到期结算成功', settle1.success === true, '结算失败', settle1);
    assert('计划状态为completed', settle1.data?.plan?.status === 'completed',
      `实际状态: ${settle1.data?.plan?.status}`, settle1.data?.plan);
    assert('达标标记为true', settle1.data?.achieved === true, '应判定达标', settle1.data);
    assert('信用分被提升到限制线30', settle1.data?.creditLift?.afterScore === 30,
      `实际: ${JSON.stringify(settle1.data?.creditLift)}`, settle1.data);

    const v1AfterSettle = await getVolunteerById(v1);
    assert('数据库中信用分已恢复为30分', v1AfterSettle.data?.credit_score === 30,
      `实际: ${v1AfterSettle.data?.credit_score}`, v1AfterSettle.data);

    const creditLogResult = await pool.query(
      "SELECT * FROM credit_logs WHERE volunteer_id = $1 AND related_type = 'recovery_plan' ORDER BY created_at DESC LIMIT 1",
      [v1]
    );
    assert('信用日志记录了解除限制', creditLogResult.rows.length === 1 && creditLogResult.rows[0].after_score === 30,
      '应写入恢复计划达标的信用日志', creditLogResult.rows[0]);

    const settleAgain = await settleRecoveryPlan(plan1Id, 'test-admin');
    assert('重复结算被拒绝（只生效一次）', settleAgain.success === false, '已结算计划不能重复结算', settleAgain);
    const plan1Final = await getPlanStatus(plan1Id);
    assert('重复结算后状态保持completed', plan1Final?.status === 'completed',
      `实际状态: ${plan1Final?.status}`, plan1Final);
    const v1AfterDuplicate = await getVolunteerById(v1);
    assert('重复结算后信用分未被重复提升', v1AfterDuplicate.data?.credit_score === 30,
      `实际: ${v1AfterDuplicate.data?.credit_score}`, v1AfterDuplicate.data);

    const afterComplete = await createServiceRecord({
      volunteer_id: v1,
      service_type: 'community_service',
      duration_hours: 1,
      rating: 5,
      is_no_show: false,
      description: '解除限制后的普通记录',
    });
    assert('达标解除限制后可正常接单', afterComplete.success === true, '解除限制后应能创建记录', afterComplete);

    // ---------------------------------------------------------
    console.log('\n--- 用例7: 计划内爽约，计划立即失效并重算信用 ---');
    const v2 = await createLowCreditVolunteer('测试志愿者-计划爽约', '13900000013');
    if (!v2) throw new Error('无法继续测试');
    const plan2Result = await createRecoveryPlan(v2, 10, futureDeadline(7), 'test-admin', '爽约测试计划');
    const plan2Id = plan2Result.data?.id as string;
    assert('第二份计划创建成功', !!plan2Id, '计划创建失败', plan2Result);

    const noShowReg = await registerRecoveryService(plan2Id, {
      volunteer_id: v2,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      is_no_show: true,
      description: '计划内爽约',
    }, 'test-admin');
    assert('爽约记录登记成功', noShowReg.success === true, '爽约登记失败', noShowReg);
    assert('计划被标记为失效', noShowReg.data?.planInvalidated === true, '爽约应使计划失效', noShowReg.data);
    assert('计划状态为invalidated', noShowReg.data?.plan?.status === 'invalidated',
      `实际状态: ${noShowReg.data?.plan?.status}`, noShowReg.data?.plan);
    assert('爽约时长不计入进度', Number(noShowReg.data?.plan?.completed_hours) === 0,
      `实际进度: ${noShowReg.data?.plan?.completed_hours}`, noShowReg.data?.plan);

    const plan2After = await getPlanStatus(plan2Id);
    assert('数据库中计划已失效', plan2After?.status === 'invalidated', `实际状态: ${plan2After?.status}`, plan2After);
    assert('失效时间已记录', !!plan2After?.settled_at, '应记录失效时间', plan2After);

    const v2After = await getVolunteerById(v2);
    assert('爽约后信用按最新记录重算', v2After.data?.credit_score !== 20,
      `信用分应被重算，实际: ${v2After.data?.credit_score}`, v2After.data);

    const regAfterInvalid = await registerRecoveryService(plan2Id, {
      volunteer_id: v2,
      service_type: 'community_service',
      duration_hours: 1,
      rating: 5,
      is_no_show: false,
    }, 'test-admin');
    assert('失效后登记被拒绝', regAfterInvalid.success === false, '失效计划不能再登记', regAfterInvalid);
    assert('返回计划不在生效状态提示', regAfterInvalid.error === '恢复计划不在生效状态',
      `实际错误: ${regAfterInvalid.error}`, regAfterInvalid);

    const settleInvalid = await settleRecoveryPlan(plan2Id, 'test-admin');
    assert('失效计划不能结算', settleInvalid.success === false, '失效计划不能结算', settleInvalid);

    // ---------------------------------------------------------
    console.log('\n--- 用例8: 投诉成立，计划立即失效并重算信用 ---');
    const v3 = await createLowCreditVolunteer('测试志愿者-投诉失效', '13900000014');
    if (!v3) throw new Error('无法继续测试');
    const plan3Result = await createRecoveryPlan(v3, 8, futureDeadline(7), 'test-admin', '投诉测试计划');
    const plan3Id = plan3Result.data?.id as string;
    assert('第三份计划创建成功', !!plan3Id, '计划创建失败', plan3Result);

    const complaintResult = await createComplaint(v3, 'poor_attitude', '服务态度恶劣，多次被服务对象反映', undefined);
    assert('投诉创建成功', complaintResult.success === true, '投诉创建失败', complaintResult);
    const complaintId = complaintResult.data?.id as string;

    const plan3BeforeResolve = await getPlanStatus(plan3Id);
    assert('投诉未处理前计划仍生效', plan3BeforeResolve?.status === 'active',
      `实际状态: ${plan3BeforeResolve?.status}`, plan3BeforeResolve);

    const handleResult = await handleComplaint(complaintId, 'resolve', 'test-admin', '投诉属实，按规定处理', 1);
    assert('投诉处理成功', handleResult.success === true, '投诉处理失败', handleResult);

    const plan3After = await getPlanStatus(plan3Id);
    assert('投诉成立后计划立即失效', plan3After?.status === 'invalidated',
      `实际状态: ${plan3After?.status}`, plan3After);
    assert('失效原因记录为投诉成立', plan3After?.settlement_note === '投诉成立，恢复计划失效',
      `实际原因: ${plan3After?.settlement_note}`, plan3After);

    // ---------------------------------------------------------
    console.log('\n--- 用例9: 到期未达标，保持接单限制 ---');
    const v4 = await createLowCreditVolunteer('测试志愿者-恢复未达标', '13900000015');
    if (!v4) throw new Error('无法继续测试');
    const plan4Result = await createRecoveryPlan(v4, 5, futureDeadline(7), 'test-admin', '未达标测试计划');
    const plan4Id = plan4Result.data?.id as string;
    assert('第四份计划创建成功', !!plan4Id, '计划创建失败', plan4Result);

    const reg4 = await registerRecoveryService(plan4Id, {
      volunteer_id: v4,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
    }, 'test-admin');
    assert('未达标志愿者登记2小时服务', reg4.success === true, '登记失败', reg4);

    await makeDeadlinePast(plan4Id);
    const settle4 = await settleRecoveryPlan(plan4Id, 'test-admin');
    assert('到期结算成功', settle4.success === true, '结算失败', settle4);
    assert('计划状态为failed', settle4.data?.plan?.status === 'failed',
      `实际状态: ${settle4.data?.plan?.status}`, settle4.data?.plan);
    assert('达标标记为false', settle4.data?.achieved === false, '不应判定达标', settle4.data);
    assert('未达标不提升信用分', settle4.data?.creditLift === null,
      `实际: ${JSON.stringify(settle4.data?.creditLift)}`, settle4.data);

    const v4After = await getVolunteerById(v4);
    assert('信用分保持20分不变', v4After.data?.credit_score === 20,
      `实际: ${v4After.data?.credit_score}`, v4After.data);

    const stillRejected = await createServiceRecord({
      volunteer_id: v4,
      service_type: 'community_service',
      duration_hours: 1,
      rating: 5,
      is_no_show: false,
    });
    assert('未达标保持接单限制', stillRejected.success === false, '未达标应继续保持限制', stillRejected);
    assert('拒绝原因仍为信用分过低', stillRejected.error === '信用分过低，无法接单',
      `实际错误: ${stillRejected.error}`, stillRejected);

    // ---------------------------------------------------------
    console.log('\n--- 用例10: 批量结算所有到期计划 ---');
    const v5 = await createLowCreditVolunteer('测试志愿者-批量结算', '13900000016');
    if (!v5) throw new Error('无法继续测试');
    const plan5Result = await createRecoveryPlan(v5, 3, futureDeadline(7), 'test-admin', '批量结算测试计划');
    const plan5Id = plan5Result.data?.id as string;
    assert('第五份计划创建成功', !!plan5Id, '计划创建失败', plan5Result);

    await makeDeadlinePast(plan5Id);
    const batchSettle = await settleDueRecoveryPlans('test-admin');
    assert('批量结算执行成功', batchSettle.success === true, '批量结算失败', batchSettle);
    assert('批量结算至少处理1份计划', (batchSettle.data?.settledCount ?? 0) >= 1,
      `实际处理: ${batchSettle.data?.settledCount}`, batchSettle.data);

    const plan5After = await getPlanStatus(plan5Id);
    assert('批量结算后计划状态为failed', plan5After?.status === 'failed',
      `实际状态: ${plan5After?.status}`, plan5After);

    const batchAgain = await settleDueRecoveryPlans('test-admin');
    assert('再次批量结算处理0份（幂等）', batchAgain.data?.settledCount === 0,
      `实际处理: ${batchAgain.data?.settledCount}`, batchAgain.data);

    // ---------------------------------------------------------
    console.log('\n--- 用例11: 查询接口 ---');
    const detailResult = await getRecoveryPlanById(plan1Id);
    assert('计划详情查询成功', detailResult.success === true, '查询失败', detailResult);
    assert('详情包含计划内服务记录', (detailResult.data?.records?.length ?? 0) === 2,
      `实际记录数: ${detailResult.data?.records?.length}`, detailResult.data?.records?.map((r: any) => r.id));

    const activeForV4 = await getVolunteerActiveRecoveryPlan(v4);
    assert('已结算志愿者无生效计划', activeForV4.success === true && activeForV4.data === null,
      'v4 的计划已结算，不应返回生效计划', activeForV4.data);

    // ---------------------------------------------------------
    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.name}`);
        if (r.error) console.log(`    原因: ${r.error}`);
      });
    }

    console.log('\n========================================\n');
    process.exit(failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
