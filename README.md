# Onstage · 少女乐队对戏

免注册昵称入场的 MyGO!!!!! / Ave Mujica 真人文字对戏空间。十个角色、自由场景、文字和贴纸、舞台/后台、旁观、房主管理、举报与历史恢复；没有 AI 代演或假在线。

当前开发版本 **0.7.0**。自托管使用 FastAPI、独立 PostgreSQL、WebSocket 提醒及 HTTP 游标补齐。SQLite 保留本地开发与旧库兼容，Sites/D1 适配继续维护。首个支持部署为 **1 应用副本、1 Uvicorn worker**；目标集群部署由合作方负责，本仓库不宣称已经上线。

## 本轮改动

- 点击发送立即在聊天流显示本人消息及小型状态圈；可靠确认后成为一条正常消息，无发送条幅或成功 toast。超时显示该条未确认状态，可使用同一 ID、原始内容重试。
- ACK 与同步使用身份范围、房间、实际成员、频道及 `client_message_id` 对账；同步先确认后，晚到错误不能倒退。POST 不推进同步游标；新文字草稿与贴纸发送互不覆盖。
- PostgreSQL 采用 SQLAlchemy/psycopg、独立 schema、显式迁移与短事务。会话限流锁、房间/举报行锁保留角色唯一、消息幂等、游标、权限和原子系统事件；不同房间不共用消息写全局锁。
- 写入确认不等待慢 WebSocket 接收者；提示按连接/房间有界合并、超时清理，断线仍从数据库补齐。日志不记录正文和凭据。
- 非 root Docker 镜像、隔离开发 Compose、真实 PostgreSQL CI、容器重启/替换持久化检查及受控 GHCR 发布。

源码来自 `onstage-v0.6.0-codex-source.zip`，原提交 `26305f3250c1fc34ab4a190a4ec429ab705a79f8`。ZIP 无 Git 历史；本仓库提交为真实接手历史，未伪造原提交。来源见 SOURCE_REVISION.json。代码许可尚未选择，第三方素材不因此取得再分发许可；公开示例内容边界见 [OPEN_SOURCE](docs/OPEN_SOURCE.md)。

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
node tests/preview_adapter_check.cjs
node edge/freeze.test.mjs
```

本次准确结果、失败和未验证项见 [acceptance](docs/acceptance.json)。旧 Sites 0.6 检查是历史证据，不能代替当前 PG/浏览器/镜像验收。真人三人、真实手机、大陆普通网络和现场延迟由实际部署参与者补验；localhost、DOM 和 CI 均不代签。

- [API_CONTRACT](docs/API_CONTRACT.md)：消息、权限和游标协议。
- [RUNBOOK](docs/RUNBOOK.md)：维护、备份、恢复及唯一写入口。
- [ARCHITECTURE](docs/ARCHITECTURE.md)：持久化、锁和通知边界。
- [DEMO](docs/DEMO.md)：演示和实机验收。
- [SELF_HOSTED](docs/SELF_HOSTED.md)：容器、CI、Kubernetes 交付合同。


## Public sample content

This public source tree contains original generated geometric sample artwork, not the original character, band, sticker or backdrop images. Business IDs and PNG paths remain stable; WebP paths are remapped to same-name SVGs. `docs/ASSET_MANIFEST.json` describes the bundled sample bytes; `PUBLIC_SOURCE_PROVENANCE.json` records excluded source identities and the original ZIP/source commit. Original `SOURCE_REVISION.json` is historical provenance, not a verification result for this tree. No code license or third-party artwork redistribution permission is implied.

To restore assets **locally only**, obtain the original package independently and unpack it to a separate private directory. Run `python tools/prepare_public_source.py restore-assets --source PATH_TO_PRIVATE_ORIGINAL --target PATH_TO_LOCAL_PUBLIC_CHECKOUT`. The command verifies all original asset hashes before restoring them, and refuses to modify a non-sample target. This changes the local content files and manifest; do not commit, push, package or redistribute the restored images without the appropriate rights. Keep the public sample branch clean, or use a separate ignored local copy for demonstrations.
