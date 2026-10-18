# Onstage 0.7 运行与恢复

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
