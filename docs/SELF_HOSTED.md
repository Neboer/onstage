# 0.9 分离部署合同（覆盖下方0.8同源默认）

API继续一个FastAPI副本/一个Uvicorn worker、独立PostgreSQL、8765端口。用户端和管理端分别是Dockerfile.frontend的web/admin target，静态HTTP端口8080，各有 /healthz。候选镜像构建/启动必须由CI实跑确认；本机没有Docker，本轮不安装系统软件。

用户端ONSTAGE_API_ORIGIN配置API的准确Origin，ONSTAGE_WS_ORIGIN配置WS Origin；容器启动生成公开config.js，不写任何秘密。分别部署两个前端域名并配置SPA回退；/play、/static、/assets应真实文件404，不回退HTML。/sw.js为原公开美术SW，根scope；仅成功的哈希媒体响应immutable，404不缓存，避免发布替换时把缺图永久缓存。发现旧HTTP错误MIME/404时，显式缓存有且只有一次绕过HTTP缓存的恢复；待更新的SW由用户在设置手动接管，不重载聊天和草稿。HTML/config/API不缓存。前端镜像只运行nginx，不运行Next或Node服务。Node/NGINX基础标签在候选阶段未锁digest；正式冻结还需记录实际构建来源与最终镜像digest。

后端ONSTAGE_PUBLIC_ORIGIN是API Origin，ONSTAGE_FRONTEND_ORIGINS为逗号分隔准确可信用户前端，ONSTAGE_ADMIN_ORIGINS为独立管理端。公开GET允许有效HTTPS *.neboer.site，其Cookie忽略且不返回credentialed CORS；账户API/WS不允许泛域。生产ONSTAGE_SECURE_COOKIE=1且所有入口HTTPS，同站子域使用SameSite Strict、API host-only __Host-onstage_session；HTTP开发用不同Cookie名。不要为了跨子域设置Domain=.neboer.site。额外反向代理需保留Origin、Upgrade与Cookie，不能统一添加宽松CORS。

```sh
# 独立环境/Secret已经指向目标，先备份、隔离恢复验证，再迁移正式库。
python tools/database.py backup /restricted/pre-community.json
python tools/database.py migrate
# 首位管理员先自行注册，维护者对准确用户名授权并留审计。
python tools/accounts.py --operator APPROVED_OPERATOR grant-admin EXACT_USERNAME
# 前端镜像分别构建，部署时注入上述公开Origin。
docker build -f Dockerfile.frontend --target web -t onstage-web:RELEASE .
docker build -f Dockerfile.frontend --target admin -t onstage-admin:RELEASE .
```

迁移使用Alembic revision20261020_01，不允许直接降级删除账户数据。新快照v2涵盖账户/授权/评分/分享等全部表；也能在迁移前备份完整旧PG schema4。先冻结旧写入口、最终导出、隔离恢复逐字段核验，再切唯一主站；旧Cookie不自动继承，不按昵称合并。旧镜像回退不能代替数据库回退；恢复前先保存新写入并明确恢复点与丢失窗口。

Compose只用于隔离开发：启动db→run migrate→up app web admin。用户端localhost:8080，管理端localhost:8081，API localhost:8765；不是外部联机部署。不修改现有代理、路由或其他服务。

CI在PR运行新前端TS/DOM/build、SQLite兼容、真实隔离PG合同、迁移与恢复、API和两个前端镜像构建/启动；受控main发布才推ghcr.io/OWNER/onstage、onstage-web、onstage-admin的commit/版本标签并输出digest。PR不获得生产凭据。合作者按已有GitOps机制选择digest并触发rollout；本仓库不声称已配置集群自动跟踪。仍使用Recreate处理API更新，无新旧应用并行写入窗口。

监控见deploy/monitoring：API /metrics需要独立Bearer Secret，20秒后台采样；Prometheus目标端口8765。Grafana JSON/YAML验证与实际导入/抓取是不同验收，后者须在对方环境执行。

---

# 自托管镜像与合作方部署

0.8新增：镜像直接包含原图与校验后的派生资源，不依赖运行时编码器。代理需放行根`/sw.js`与`/static/manifest.webmanifest`，保持JS/JSON正确MIME及SW根scope；HTTPS下支持安装和公开美术缓存。仅`/static/assets/optimized/<sha256>.webp`长期immutable，HTML/JS/清单重新校验，API保持no-store，勿在全局代理统一覆盖这些头。应用已压缩文本，不重复压缩图片；代理若统一压缩需避免重复处理。PWA不改变Cookie/Origin、HTTP补齐、WS Upgrade、单副本或独立PG要求。

PG部署仍先备份并独立运行`python tools/database.py migrate`，本轮追加分页索引；不需新数据库容器、权限或破坏性schema切换。合作方负责目标更新与设备验收，源码通过不等于CD上线。具体缓存/旧资源回退见RUNBOOK。

本文件是部署操作合同。配置文件存在、静态检查通过或 Actions 成功，均不代表公网、集群 CD、手机和真人验收完成。首个支持目标为 Linux amd64、一个应用副本、一个 Uvicorn worker、独立 PostgreSQL 16；共享前端由同一 FastAPI 镜像提供。SQLite 仅保留旧数据兼容和明确的本地开发路径。

## 本机隔离演练

安装 Docker Engine / Compose v2 后，在源码根目录执行：

```sh
docker compose -f compose.dev.yaml up -d db
docker compose -f compose.dev.yaml run --build --rm migrate
docker compose -f compose.dev.yaml up --build -d app
curl --fail http://localhost:8765/readyz
```

该 Compose 的密码明确只用于隔离开发；数据库无宿主端口，应用只绑定 loopback，不是多设备部署。数据在具名卷 `onstage-isolated-dev_development-postgres`；普通 `down` 保留卷，不能使用 `down -v` 清除旧数据。生产不部署此数据库服务。镜像只复制白名单业务源码、静态资产、维护工具和来源记录，排除 `.env`、数据库、日志、私有导出、vendor 和前端构建依赖；进程 UID/GID 为 10001，端口 8765，不需要 root。

运行入口固定为 `python -m uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1 --no-access-log --no-proxy-headers --ws-per-message-deflate false`。启动不迁移 PostgreSQL，只校验已有 schema。`/healthz` 是进程存活，`/readyz` 实际检查数据库/schema；不能以存活代替就绪。数据库凭据通过 `DATABASE_URL` Secret 注入，格式 `postgresql+psycopg://USER:PASSWORD@HOST:5432/DB?sslmode=require`，特殊字符须 URL 编码。应用环境仅保留精确公共 Origin、Secure Cookie 和 release commit；来源信息见 `SOURCE_REVISION.json` 及镜像 OCI revision 标签。

## 独立迁移、备份和恢复

正式操作前维护者必须核对目标数据库、现有写入口、备份目的地和可恢复版本。维护命令读取同一 `DATABASE_URL`，不得无意回退到 SQLite。仅在受控秘密环境中运行，不能把实际连接串输入聊天、命令行参数或源码。

```sh
python tools/database.py backup /restricted/onstage-before-release.json
# 将 DATABASE_URL 指向独立且空的恢复演练库，再执行：
python tools/database.py migrate
python tools/database.py restore /restricted/onstage-before-release.json
python tools/database.py verify /restricted/onstage-before-release.json
# 目标确认无误后，使用正式库 Secret，单次受控执行：
python tools/database.py migrate
```

同样命令可用 release 镜像运行；备份目录单独挂载并只授予 UID 10001 所需读写权限，不将备份烘入镜像或上传 Actions。先在独立 PostgreSQL 恢复、校验稳定 ID、消息游标、席位、权限、贴纸及举报快照，再切换；业务探针补验抢角、发送、权限与历史。SQLite 导入入口为 `python tools/database.py import-sqlite /restricted/final.sqlite3`；Sites 的 `onstage-confidential-state-v1` schema 4 私有快照可通过 `restore` 受控导入，不能把 D1 JSON 传给 `import-sqlite`。该旧快照缺少 `rate_events`，不等价于物理备份；恢复后保留业务表、稳定 ID 和权限，但不能宣称历史限流窗口也已迁移。新 PostgreSQL 私有快照包含限流表。第一次切换先冻结旧站写入，再取最终一致性导出和恢复核验，最终仅一个主站接收写入。换域名按新访客入场；不得凭昵称恢复房主权限。

`deploy/migrate-job.yaml` 为显式 Kubernetes Job 模板，`backoffLimit: 0`；使用与应用相同 digest 和 Secret，不能作为每个 Pod 的 initContainer。维护者先完成写冻结、备份及恢复演练，停止旧应用，等待 Job 成功再启动新应用。跨 schema 回退需要恢复已核验备份，不能只回滚镜像。

## 集群交付与代理

`deploy/kubernetes.yaml` 是待维护者填充的模板，必须替换 digest、Origin、commit 并在指定 namespace 应用。数据库由已有独立 PostgreSQL 提供；`onstage-database` Secret 的键名为 `DATABASE_URL`。GHCR 私有镜像使用维护者已有的只读 imagePullSecret/工作负载身份，必要时为 Pod 增加精确 `imagePullSecrets` 引用，不请求集群管理员凭据。

副本始终为 1，策略为 `Recreate`，不配置 HPA。Recreate 处理普通 Deployment 更新的重叠；维护者仍须排除第二个 Deployment、手动 Pod、并行 namespace 或预览实例连入同一生产库。未验收跨进程通知、presence、连接限制和权限撤销前，不得改为多 worker、多副本或 blue/green。

由合作方既有 Ingress/反向代理终止 TLS 并路由至 Service 8765；保持同一精确 HTTPS Origin、原 Host，透传 `/api/rooms/*/stream` 的 WebSocket Upgrade/Connection，允许至少 75 秒空闲读取并关闭 WebSocket 缓冲。HTTP 游标补齐继续工作。勿修改全局代理、Headscale 或无关路由；Ingress 类、证书、WebSocket 参数按对方现有机制配置。readiness `/readyz`、liveness `/healthz`；初次启动先经 startupProbe 校验就绪。PostgreSQL 连接数、备份、TLS、持久化和恢复由独立数据库维护。

交接必须记录：实际镜像 `ghcr.io/OWNER/REPO@sha256:...`、release commit、Actions run URL、架构 `linux/amd64`、8765、两个探针、数据库 Secret 引用、显式迁移 Job、公共 Origin、WS 规则、唯一写入口、旧 digest/备份和回退人。占位符清单不代表已部署。

## CI、发布和更新责任

`.github/workflows/self-hosted.yml` 在 PR/main/manual/release 上运行 Python 回归、隔离真实 PostgreSQL 集成、幂等迁移、前端确认乱序测试、实际镜像构建和容器 HTTP/WebSocket/DOM 验证。用同一持久 PG 进行容器重启及删除重建后的消息/身份恢复。DOM 和合成独立会话不代替真实浏览器、手机或至少三位真人。CI PG 只含合成数据、临时密码，不获取生产凭据。官方 Actions 绑定完整 commit SHA；仓库应对 main 开启 PR review 和本工作流 required checks，不可绕过审查直接修改发布工作流。

首次 push main 自动执行验证和实际镜像构建／运行，不自动发布镜像。仅上述验证成功后、从 main 手动触发 workflow 或指向 main 祖先的已发布版本可推 GHCR，权限为 `contents: read` 和发布 job 的 `packages: write`。PR 只有读权限，不使用 `pull_request_target`。手动发布推 `sha-<40位commit>`；规范 release `vX.Y.Z` 再推版本标签；不发布漂移的 `latest`。主线合入本身需要仓库保护，workflow 文件不能替代权限策略。发布 job 重新构建同一已验证 commit，输出不可变 digest、OCI revision、最小 provenance 和 SBOM，Actions Summary/`image-release-*` artifact 留存证据。基础镜像 digest 和 Python依赖已固定，后续安全更新须新 PR 验证。未实际成功运行时只可报告配置完成。

本仓库没有擅自给合作方集群增加 CD 权限，也不会从 Actions 直接改集群。由合作方指定维护者在其已有 GitOps 仓库提交准确 digest，复用其已配置的 rollout；若要求自动跟踪，必须另外明确现有 Argo/Flux 镜像策略、写回目标、权限、审批与负责人，再用一次真实 digest 更新证明跟踪和 rollout。`imagePullPolicy`、Deployment 或仅安装 Argo/Flux 均不会自动完成镜像监视。演示前将 GitOps 固定为审核通过的 release/digest，并暂停自动版本写回到演示结束；后续无关提交不得切换演示版本。

回退：先停止新版本写入，评估 schema 是否兼容；兼容时维护者将 GitOps digest 改回已验证旧镜像并以 Recreate 更新；不兼容时恢复隔离验证过的备份再切换唯一写入口。回退造成备份之后记录丢失的风险必须在执行前说明并保存现场。

设计参考：[Docker GitHub Actions 与 provenance](https://docs.docker.com/build/ci/github-actions/attestations/)、[Kubernetes Deployment 策略](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)。具体现场验证结果以本次 acceptance 和交接记录为准。

## 完整内容与协作者

仓库包含原始185个美术文件，Dockerfile的static目录复制和.dockerignore白名单将其一起放入镜像；不依赖额外素材下载或本机原包。测试逐文件核对来源清单，并从实际应用HTTP入口检查185个资源响应的内容哈希与图片MIME。Neboer已受邀为个人仓库协作者（write为该仓库可授予协作者的最高权限）；所有者仍为SpringfiledBucks，未转移仓库。邀请状态见acceptance。
