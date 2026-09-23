# Dynamic Panel Sync Server

Dynamic Panel 的独立自托管同步服务。桌面客户端位于相邻的 `TO-DO-Panel` 仓库，本仓库负责 Fastify API、Web 控制台、PostgreSQL 持久化、对象存储、备份恢复、迁移和管理员 CLI。

## 技术栈

- Node.js 22.13+
- Fastify 5
- PostgreSQL 17
- 文件系统或 S3 兼容对象存储
- 原生 `node:test`

## 命令

- 安装：`npm ci`
- 检查：`npm test`
- 启动 API：`npm start`
- 启动备份 worker：`npm run worker`
- 数据库迁移：`npm run migrate`
- 管理 CLI：`npm run cli -- --help`
- Compose 校验：`docker compose -f compose.example.yml config`

## 目录

```text
.
├── src/                    # API、领域服务、CLI、worker 与 Web 控制台
├── migrations/             # PostgreSQL schema 与 RLS 迁移
├── test/                   # 确定性及可选基础设施测试
├── docs/                   # 部署、实现设计与验收记录
├── Dockerfile
├── compose.example.yml
└── .env.example
```

## 约束

- 生产必须使用 PostgreSQL、HTTPS 或可信反向代理、持久对象存储以及独立故障域的加密备份。
- 内存适配器只用于测试和开发，不得作为生产持久化方案。
- 跨租户运维读取必须使用显式管理员事务上下文并受 RLS 保护。
- 客户端 Key、账号密码、Cookie Secret、游标密钥、备份主密钥及云凭据不得提交。
- API/协议修改必须同步检查相邻桌面仓库的 `main/sync/` 和协议产品文档。
- 不得把桌面 Electron 运行时代码复制到本仓库。

## 测试门禁

`npm test` 是提交前最低门禁。PostgreSQL、S3、Docker、负载/恢复演练属于显式环境门禁，未执行时不得声明生产验收通过。
