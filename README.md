# 志愿者积分与信用评估

记录志愿服务、计算积分信用、处理投诉和生成排行榜的后端服务。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- 前端：http://localhost:8243
- 后端健康检查：http://localhost:3243/api/health
- 数据库端口：localhost:5743

停止并清理容器、网络和数据卷：

```bash
docker compose down -v --remove-orphans
```

## 主要功能

- 志愿者档案与服务记录
- 积分、徽章和信用分计算
- 投诉处理、后台调整和排行榜
- 低信用志愿者恢复计划（观察期）

## 低信用志愿者恢复计划

当志愿者信用分低于 30 分时进入接单限制。管理员可为其创建带**目标时长**和**截止日期**的恢复观察期：

- 观察期生效后，普通服务记录仍被拒绝，**仅管理员可登记计划内恢复服务**；
- 出现**已成立投诉**或**爽约**时计划立即失效，并按最新记录重算信用分，接单限制保持；
- 截止时**达标才解除接单限制**，未完成则保持限制；
- 同一志愿者同一时间只能有一份进行中的计划；
- 创建、进度更新、到期结算均**只生效一次**（计划内登记要求携带 `idempotency_key`），所有写操作在单个数据库事务内完成，失败不留下半更新。

管理端接口（需要管理员令牌）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/admin/recovery-plans` | 创建观察期（`volunteer_id`、`target_hours`、`deadline`） |
| GET | `/api/v1/admin/recovery-plans` | 计划列表（可按 `status`、`volunteer_id` 过滤） |
| GET | `/api/v1/admin/recovery-plans/:id` | 计划详情（到期自动结算一次） |
| POST | `/api/v1/admin/recovery-plans/:id/settle` | 到期结算（不可提前、不可重复） |
| POST | `/api/v1/admin/recovery-plans/:id/services` | 管理员登记计划内恢复服务（携带 `idempotency_key`） |
| POST | `/api/v1/admin/recovery-plans/:id/no-shows` | 管理员登记观察期内爽约（计划立即失效） |

志愿者侧只读接口：`GET /api/v1/volunteers/:id/recovery-plan` 查询当前进行中的观察期。

## 本地开发

前端：

```bash
cd frontend
npm install
npm run dev
```

后端：

```bash
cd backend
npm install
npm run dev
```

数据库可通过根目录的 Docker Compose 单独启动：

```bash
docker compose up -d db
```

## 测试

恢复计划测试默认使用 pg-mem 内存数据库，无需外部 PostgreSQL：

```bash
cd backend
npm install
npm run test:recovery-plan     # 业务规则与幂等（内存库）
npm run test:recovery-auth     # 接口鉴权（内存库）
```

需要验证真实事务回滚语义时，指向一个真实 PostgreSQL 并运行：

```bash
DB_HOST=localhost DB_PORT=5743 DB_NAME=volunteer_db \
DB_USER=volunteer_user DB_PASSWORD=volunteer_pass \
npm run test:recovery-plan:real
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Static HTML + Nginx |
| 后端 | Express + TypeScript |
| 数据库 | PostgreSQL |
| 部署 | Docker Compose + Nginx |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── .env
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
├── backend/
│   ├── Dockerfile
│   └── ...
└── database/
    └── ...
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| COMPOSE_PROJECT_NAME | Compose 项目名，避免中文目录名导致项目名为空 | gb-143 |
| DB_NAME | 数据库名称 | volunteer_db |
| DB_USER | 数据库用户 | volunteer_user |
| DB_PASSWORD | 数据库密码 | volunteer_pass |
| DB_ROOT_PASSWORD | 数据库 root/superuser 密码 | volunteer_root_pwd |
| JWT_SECRET | 后端签名密钥 | volunteer_credit_secret_key_2026 |
| FRONTEND_PORT | 前端宿主机端口 | 8243 |
| BACKEND_PORT | 后端宿主机端口 | 3243 |
| DB_PORT | 数据库宿主机端口 | 5743 |

## Docker 部署说明

- `docker-compose.yml` 顶层已声明 `name: gb-143`，可以在中文目录名下直接运行。
- 数据库使用 Docker 命名卷 `db_data` 持久化，不绑定到宿主中文路径。
- 前端容器使用 Nginx 托管静态资源，并将 `/api` 反向代理到后端服务名 `backend`。
- 后端会等待数据库健康后再启动，前端会等待后端健康后再启动。
- 如本机端口冲突，修改根目录 `.env` 中的 `FRONTEND_PORT`、`BACKEND_PORT` 或 `DB_PORT`。

## License

MIT
