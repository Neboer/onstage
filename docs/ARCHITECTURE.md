# Onstage 0.7 架构

共享 `static/` 与 `app/catalog.json` 是界面/内容唯一来源。FastAPI 使用 PostgreSQL（生产目标）或明确的 SQLite（本地/旧库）适配；Sites 使用保留的 D1 适配；离线 adapter 仅用于显式评审。语言重写和服务拆分后置。

## 事务和一致性

`app/store.py` 维护共享领域规则、命名参数 SQL；`app/postgres.py` 使用 SQLAlchemy 连接池与 psycopg，PostgreSQL schema 单独维护。没有运行时 SQL 文本翻译器。PG 迁移由 `tools/database.py migrate` 显式执行，应用启动只检查 schema 4。

写事务锁顺序为会话 advisory 锁（同会话跨房限流）、相关 admission 锁（仅创建会话/房间容量）、房间行锁、举报行锁。维护者结案先定位不可变房间 ID，再按房间→举报顺序锁定。角色唯一和消息幂等还有数据库约束兜底。读使用 REPEATABLE READ 快照，授权与所读后台/举报保持同一时点。超时回滚并返回未确认，客户端保留原 ID 重试；不以错误推断原发送一定未写入。

频道 `seq` 在房间事务内分配，可随业务回滚；report/rate 的真实 identity 字段导入后校正序列。成员改变、权限检查、系统事件与消息序号在同一事务内。数据库共享不会共享内存 Hub。

## 发送与恢复

本轮保留每房一条 pending，允许继续编辑新草稿。pending 有身份范围/room/member/channel/client ID 及原内容快照。ACK 和 sync 先统一对账，再按服务端消息 ID 去重；成功不可倒退。POST 确认不推进分页游标，sync cursor 仅指实际交付消息。贴纸发送不清文字草稿。响应 `client_message_id` 仅为对账标识，不提供绕过权限的查询入口。

写入确认只等待持久化。Hub 维护一个生命周期调度任务，每连接最多一个发送任务，连接上限 100；房间提示合并，慢连接有发送与关闭期限，不为每条消息创建无界任务。WS 只发失效提示，HTTP 补齐保存的正文。接收异常/重连不释放角色。

首个部署严格单副本、单 worker，更新 Recreate，允许短暂重连。未实现/验收跨实例通知、presence、限制和撤权前不扩容，亦不采用短暂双实例蓝绿部署。

## 运维和观测

维护、迁移、备份、恢复和导入读取同一个 DATABASE_URL；旧 SQLite 路径明确标注。恢复拒绝覆盖已有业务数据，先在隔离 PG 检查字段/外键/稳定 ID/游标/贴纸/举报。ONSTAGE_WRITE_FROZEN=1 阻止业务 HTTP 写入，GET 和维护者导出保留；需部署/重启后实际探测才算冻结。

X-Request-ID 与 Server-Timing 提供 HTTP/DB 操作时长；DB 计时包含线程排队、锁/连接等待及领域操作，不等于纯 SQL 执行时间。通知耗时单独日志记录。前端与真实设备端到端测量另计；本地乐观显示不等于跨端送达。当前没有大陆/现场/Sites同设备延迟结论。

新域名 Cookie 不自动迁移，昵称只显示，不能找回或合并权限。当前交付范围为开发/验证/公开 GitHub；实际迁库、部署、GitOps 和真人网络验收由后续维护者执行。详见 RUNBOOK、SELF_HOSTED、acceptance。
