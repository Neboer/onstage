# 0.9 运维优先说明

本版本新增账户、私密房、作者授权分享与管理权限，配置和迁移按SELF_HOSTED的0.9部分执行。用户与管理前端独立部署，8765为API；ONSTAGE_FRONTEND_ORIGINS/ONSTAGE_ADMIN_ORIGINS只填准确可信Origin。*.neboer.site仅公开读，不是登录白名单。

新版本账号与登录会话分离；首次管理员由维护命令授予。ban撤销所有登录，解封不恢复旧token。不要在聊天/工单/日志输出密码、Cookie、快照或真实数据库连接串。ONSTAGE_METRICS_TOKEN单独注入Prometheus Secret。

工具database.py使用同一DATABASE_URL，backup兼容完整旧schema4与新v2，restore仅空目标并验证所有新表；生产PG独立执行Alembic迁移，启动只检查。已有SQLite首次扩展自动先留一致性备份，旧包/原图/旧ID不删除。正式切换和回滚需完整库恢复计划，不能仅替换代码。

在线是90秒租约与有效账户会话，不是连接数。服务重启重置全离线观察期；单副本更新须Recreate。自动结束事件、场景切换、权限与消息都必须实际验证，不能用health代签。

---

# Onstage 0.8 运行与恢复

## 美术、PWA与分页更新

直接部署Git中的原图、哈希派生和资源清单，不需线上安装图像处理工具。原`docs/ASSET_MANIFEST.json`标识原始185文件，`static/assets-manifest.json`标识传输派生；目录和历史快照继续保存原路径。验证命令：

```sh
python tools/optimize_assets.py verify
# 作者/CI需要逐像素验证时，使用独立依赖，不进入运行镜像
python -m pip install -r requirements-assets.txt
python tools/optimize_assets.py verify --pixels
# 更新素材时：使用官方libwebp 1.6.0 cwebp，受控重新生成后审查差异
python tools/optimize_assets.py build --cwebp /path/to/cwebp
```

禁止覆盖已发布内容hash文件，禁止清掉仍可能被旧页面引用的原图/旧hash文件。素材或颜色配置不满足严格比较时构建报错；未变资源复用URL。清单/HTML/脚本重新校验，不可被代理改成长期immutable。不要对`/api/`启用共享缓存。

PWA需公共HTTPS；localhost仅作隔离验证。根`/sw.js`必须到达应用并返回JS和`Service-Worker-Allowed: /`，不得被代理改为HTML或要求登录。使用设置可主动保存约16.31 MB完整美术、取消或清除本应用缓存；存储不足/被清理会回源，身份与草稿不随清除操作删除。当前未提供离线聊天/历史读取、跨域身份迁移或强制更新。旧页面会在关闭后按浏览器生命周期启用新SW；发布不应强迫所有页面刷新。

PG升级前仍按本文备份、隔离恢复并显式执行`python tools/database.py migrate`；本轮仅追加三个分页索引，schema 4与旧应用兼容，不执行删列或删数据。D1维护者执行受控`0001_room_pagination`迁移；SQLite沿用既有初始化/旧库迁移路径。应用Pod不并发执行迁移。大量房间的索引建立仍需维护窗口监测，千房测试不是百万级建索引时长承诺。

前端每页24间，刷新/筛选重回第一页。游标绑定身份与筛选，过期身份应重新入场，不尝试改游标恢复权限。总房间数可超过1000，不提高默认10间活跃房准入。回滚0.7代码可保留新增索引，但需连同静态资源、清单和SW一起回退；浏览器内原美术缓存不包含业务数据，也不代替数据库备份。

本轮交付开发与公开 GitHub。目标部署由合作方负责；没有执行旧站冻结、生产导出或目标集群切换。镜像/端口/探针/Secret/单副本和 CI 契约见 [SELF_HOSTED](SELF_HOSTED.md)。所有动作只针对已核对的本项目资源，不修改全局代理、路由或其他采集器。

## 配置与启动

生产 DATABASE_URL 由 Secret 注入，公共 ONSTAGE_PUBLIC_ORIGIN 必须精确，公网 Secure Cookie=1。端口8765、一个 Uvicorn worker、一个应用副本、Recreate 更新。镜像 UID/GID10001，生产 PG 独立持久化；不要将生产连接串作为CLI参数。

```sh
python tools/database.py migrate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1 --no-access-log --no-proxy-headers --ws-per-message-deflate false
```

迁移是独立受控步骤，失败不启动新应用；不能每 Pod 自动迁库。healthz 仅进程存活，readyz 实际检查DB/schema；还须使用独立会话验证消息和权限。反向代理保留精确Origin与WebSocket Upgrade，仅信任核对过的代理；当前默认不接受代理头，不能据此声称获得真实来源IP。

## 备份和隔离恢复

使用与应用相同的 DATABASE_URL。备份含会话、后台和举报，保存在源码之外受限目录，不上传Git、镜像、Actions artifact。POSIX使用0600；Windows mode位不代表NTFS ACL，维护者须实际限制目录访问。大库使用已验证的原生PG备份，业务JSON有明确体积/行数限制。

```sh
python tools/database.py backup /restricted/pre-release.json
# 在独立空PG库环境中
python tools/database.py migrate
python tools/database.py restore /restricted/pre-release.json
python tools/database.py verify /restricted/pre-release.json
```

restore在事务内拒绝覆盖已有业务数据，逐字段检查ID、外键、游标与快照，校正实际identity序列。SQLite schema4 可用 import-sqlite 导入；旧schema须先在独立SQLite副本按旧迁移机制备份升级。D1 onstage-confidential-state-v1 用restore接入，旧D1业务导出不含临时presence和rate_events，不能称为完整限流窗口恢复。

旧 SQLite 文件备份仍支持 tools/backup.py SOURCE DESTINATION；使用 SQLite backup API，不只复制活跃WAL主文件。DATABASE_URL已配置时，维护工具不得悄悄修改另一份SQLite。举报运维 tools/moderate.py 读取同一连接配置；处理输出为私密材料，不能投屏或发布。

## 唯一主站切换

1. 明确旧业务主库、备份位置、最终恢复点和负责人；不合并不明来源数据。
2. 在隔离PG导入并校验历史/权限/贴纸/举报，验证并发与应用重启留存。
3. 在旧站部署 ONSTAGE_WRITE_FROZEN=1，探测真实POST确实503，维护者GET导出仍可用；仅写文档不算冻结。保留恢复路径。
4. 最终受控导出→目标恢复→逐字段核验→唯一入口切换。新站写入后旧站保持只读。
5. 新域名默认新访客进入新房；保留历史不等于浏览器身份无感迁移，不能按同名恢复房主。

回退先冻结新写入、保存新数据和故障现场。schema兼容可切旧digest；不兼容须另行恢复已核验的数据库备份，说明恢复点之后数据处理，不以回滚镜像冒充回滚数据库。不能新旧两站各自持续写入。

## CI与协作

PR/main执行回归、隔离PG与容器检查。main手动发布或版本发布验证通过后推GHCR，记录commit/tag/digest/run。GitOps由合作方现有机制接入，Deployment或imagePullPolicy不会监视更新；现场演示固定release/digest。没有集群授权时不宣称CD上线。

日程为北京时间2026-10-19 12:00冻结、18:00演示。实际手机/三人/大陆和现场检查见DEMO，状态以acceptance为准。
