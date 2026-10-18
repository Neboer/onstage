# Onstage · 少女乐队对戏

免注册昵称入场的 MyGO!!!!! / Ave Mujica 真人文字对戏空间。十个角色、自由场景、文字和贴纸、舞台/后台、旁观、房主管理、举报与历史恢复；没有 AI 代演或假在线。

当前开发版本 **0.8.0**。公开协作仓库：[SpringfiledBucks/onstage](https://github.com/SpringfiledBucks/onstage)。自托管使用 FastAPI、独立 PostgreSQL、WebSocket 提醒及 HTTP 游标补齐。SQLite 保留本地开发与旧库兼容，Sites/D1 适配继续维护。首个支持部署为 **1 应用副本、1 Uvicorn worker**；目标集群部署由合作方负责，本仓库不宣称已经上线。

## 本轮改动

- 完整保留185张原始美术及历史路径，新增经过RGBA/ICC验证的无损派生与哈希清单，整套传输21.73→16.31 MB（减少24.91%）。哈希图片长期缓存，HTML/脚本/清单重新校验，API保持no-store，文本启用gzip。新增消息保留已有图片节点。
- PWA安装清单与同源美术持久缓存；使用设置可主动保存完整素材、查看进度、取消或清除本应用缓存。首次打开不预载全图，聊天/身份/举报不进入此缓存，离线不能多人对戏。需HTTPS或localhost，浏览器可能清理缓存。
- 房间列表每页24间，后端默认50/最多100，服务端筛选与稳定游标支持大量历史房间；以1107间隔离房间验证，未提高活跃房/连接容量上限。
- 结束房默认从开头回看并提供“跳到开头”；聊天提供常驻“跳到最新消息”。默认Enter发送、Shift+Enter换行，使用设置可改回Ctrl/⌘+Enter发送，保留IME保护。
- 重构评估见[ARCHITECTURE](docs/ARCHITECTURE.md)：推荐保持协议的模块化，估算12–21人日；原生客户端、语言重写与拆服务暂缓。此为后续规划估算。

- 点击发送立即在聊天流显示本人消息及小型状态圈；可靠确认后成为一条正常消息，无发送条幅或成功 toast。超时显示该条未确认状态，可使用同一 ID、原始内容重试。
- ACK 与同步使用身份范围、房间、实际成员、频道及 `client_message_id` 对账；同步先确认后，晚到错误不能倒退。POST 不推进同步游标；新文字草稿与贴纸发送互不覆盖。
- PostgreSQL 采用 SQLAlchemy/psycopg、独立 schema、显式迁移与短事务。会话限流锁、房间/举报行锁保留角色唯一、消息幂等、游标、权限和原子系统事件；不同房间不共用消息写全局锁。
- 写入确认不等待慢 WebSocket 接收者；提示按连接/房间有界合并、超时清理，断线仍从数据库补齐。日志不记录正文和凭据。
- 非 root Docker 镜像、隔离开发 Compose、真实 PostgreSQL CI、容器重启/替换持久化检查及受控 GHCR 发布。

源码来自 `onstage-v0.6.0-codex-source.zip`，原提交 `26305f3250c1fc34ab4a190a4ec429ab705a79f8`。ZIP 无 Git 历史；本仓库提交为真实接手历史，未伪造原提交。来源见 SOURCE_REVISION.json。代码许可尚未选择，第三方素材不因此取得再分发许可；素材来源与许可边界见 [OPEN_SOURCE](docs/OPEN_SOURCE.md)。

## 本地开发

需要 Python 3.12；普通 Python 服务不需要 Node 构建。

```sh
python -m venv .venv
# Windows 使用 .venv\Scripts\python.exe，Linux/macOS 使用 .venv/bin/python
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python tools/run_local.py
```

该命令仅启动 loopback SQLite 开发实例，不等于手机联机或目标部署。PostgreSQL 与镜像运行见 [SELF_HOSTED](docs/SELF_HOSTED.md)，生产凭据通过环境/Secret 注入，不写命令参数或源码。迁移须单独执行，应用启动只检查 PG schema。

```sh
# DATABASE_URL 已由受控环境设置，指向获准的隔离 PostgreSQL
python tools/database.py migrate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1 --no-proxy-headers
```

必须设置精确 `ONSTAGE_PUBLIC_ORIGIN`；公网 `ONSTAGE_SECURE_COOKIE=1`。旧数据先受控备份，在隔离 PG 恢复逐字段核验，再冻结旧入口、最终导出并切换唯一主站。跨域 Cookie 不自动迁移，演示默认新访客新房，不能凭同名昵称接管历史身份。

## 验证与交付

```sh
python -m pytest -q --ignore=tests/test_postgres.py
# 只允许显式指定隔离测试库；每个 PG 测试创建自己的随机 schema
ONSTAGE_TEST_DATABASE_URL=... python -m pytest tests/test_postgres.py -q
npm ci --ignore-scripts
node tests/frontend_delivery_check.cjs
node tests/frontend_navigation_check.cjs
node tests/pwa_cache_check.cjs
node tests/preview_adapter_check.cjs
node edge/freeze.test.mjs
node edge/room-pagination.test.mjs
```

本次准确结果、失败和未验证项见 [acceptance](docs/acceptance.json)。旧 Sites 0.6 检查是历史证据，不能代替当前 PG/浏览器/镜像验收。真人三人、真实手机、大陆普通网络和现场延迟由实际部署参与者补验；localhost、DOM 和 CI 均不代签。

- [API_CONTRACT](docs/API_CONTRACT.md)：消息、权限和游标协议。
- [RUNBOOK](docs/RUNBOOK.md)：维护、备份、恢复及唯一写入口。
- [ARCHITECTURE](docs/ARCHITECTURE.md)：持久化、锁和通知边界。
- [DEMO](docs/DEMO.md)：演示和实机验收。
- [SELF_HOSTED](docs/SELF_HOSTED.md)：容器、CI、Kubernetes 交付合同。


## 完整美术与部署

按仓库所有者于2026-10-18的明确要求，仓库已包含原包全部 **185 个原始美术文件**，包括角色图、乐队图、场景图和143张贴纸；恢复原始资源路径，逐文件身份见 `docs/ASSET_MANIFEST.json`。克隆即可使用完整内容，不需要再下载素材包或运行恢复工具。

```sh
git clone https://github.com/SpringfiledBucks/onstage.git
cd onstage
docker compose -f compose.dev.yaml up -d db
docker compose -f compose.dev.yaml run --build --rm migrate
docker compose -f compose.dev.yaml up --build -d app
```

此命令是隔离开发演练，打开 `http://localhost:8765`；真实多人对外部署按 [SELF_HOSTED](docs/SELF_HOSTED.md) 配置公共 Origin、独立 PostgreSQL、TLS/WS代理和单副本。素材已随Git和Docker构建上下文交付，来源信用与代码许可分别记录；没有替第三方新增许可声明。

## 当前交付状态

开发与公开源码推送已完成，本地Python/真实PostgreSQL/发送对账及公开示例集成已验证。GitHub Actions已触发，但账户账单锁导致runner未启动；[实际失败回执](https://github.com/SpringfiledBucks/onstage/actions/runs/39116782810)不是应用测试失败，也不是CI通过。没有实际镜像digest。账户恢复后重跑工作流，main手动发布可在验证通过后推GHCR。未操作账单或目标部署。详情见docs/acceptance.json。
