> 0.7接手更新：生产目标为FastAPI/PostgreSQL，SQLite只作本地/旧库兼容，D1仍维护。PG必须先显式运行 tools/database.py migrate，应用不自动DDL；DATABASE_URL经Secret注入，运维工具读取同一目标。单副本单worker与消息契约不受持久化方言改变。ONSTAGE_WRITE_FROZEN=1阻止业务HTTP写入，需重启/发布后验证。下文0.6拓扑是历史，业务权限继续有效。

# Onstage 昵称访客多人对戏接口与状态约定（schema 4）

本文件约定共享前端和两种真实后端的业务协议。`0.6` 在现有 Sites 地址运行 TypeScript／Workers＋共享 D1；本地与自有主机保留 Python／FastAPI＋SQLite。两者使用同源 HTTP、昵称访客、角色与消息权限以及持久记录规则；具体平台适配见 [ARCHITECTURE](ARCHITECTURE.md)。只有显式生成的离线评审包加载 `preview/adapter.js`，正式 Sites 不加载它，也不使用浏览器本地房间当作服务端。

`schema_version:4` 为业务结构；D1 额外 `edge_schema_version:1` 管理共享事务守卫和在线心跳。D1 的唯一线上业务库不会自动合并本机 SQLite 或旧评审数据。实际发布、独立会话、浏览器和大陆网络分别登记证据。

## 架构与身份

- 本地后端为 Python 3.12、FastAPI、标准库 sqlite3、一个 Uvicorn 进程；Sites 后端为 TypeScript／Cloudflare Workers、共享 D1。浏览器始终同源访问 API，数据库保存业务状态；传输采用服务端声明的 HTTP 轮询或既有 WebSocket 通知。
- Cookie `onstage_session` 为随机匿名凭证，HttpOnly、SameSite=Strict；公网 Secure=1，数据库只保存 token hash。有效期默认 7 天。不公开平台 session ID，不提供跨浏览器找回。
- `POST /api/session` 接受 `{nickname?:string|null}`、`{}` 或空请求体。已有有效 Cookie 时返回同一个身份和 CSRF，不新建/旋转身份；不存在、已撤销或过期才创建新匿名会话。不接受邀请码字段。昵称不是凭据，允许重名，绝不按昵称查找、恢复或合并另一个身份。
- 非空昵称去掉首尾空格后最多 24 字，禁止控制/格式字符（Unicode Cc、Cf、Cs）及换行分隔符（Zl、Zp）。省略、null 或普通全空白昵称不清除已有昵称；无昵称的新/旧会话返回 `nickname:null,requires_nickname:true`，保留旧程序化调用兼容。网页在此状态要求填昵称，服务端原有房间接口不因此阻断旧客户端。
- 新会话可直接带昵称；有效会话首次补昵称或改为不同的非空昵称，须提供原 `X-CSRF-Token`。重复提交同一昵称幂等。更名仅改变当前显示称呼并通知所在房间同步，不旋转 Cookie/CSRF，不改变席位、房主权限或已保存消息。
- 后续修改操作要求 `X-CSRF-Token`。HTTP 核验存在的 Origin；WS 必须提供精确匹配的 Origin。凭证不能出现在 URL。
- 每房独立成员 ID。公开 `alias` 仍为稳定的“观众 1”等简短称呼；新增 `nickname` 为当前显示昵称或 null；`display_name` 依次取当前角色名、昵称、该序号称呼。schema 1 原别名保留在库内，其历史匿名作者映射成简短称呼，不公开“旅人·HEX”。昵称不会替代内部成员 ID。
- 状态为 `preparing`、`live`、`paused`、`ended`。一人一角，一房一场；断线不退角，正式离房释放当前席位但保留最初角色限制。同场重新入席只能选择最初角色。
- 房主也可直接选一个空角色；没有逐人申请和审批。准备阶段可直接选角，live/paused 是否接纳新演员由 `allow_join` 决定。后台只向房主和现任演员开放。
- ended 后场景正文、背景、公告、席位与移出操作只读；举报与其处理是独立治理记录，可在结束后继续。

## 配置与容量

必须配置 `ONSTAGE_PUBLIC_ORIGIN`（不带路径的精确 HTTP(S) Origin）；`ONSTAGE_DATA_DIR` 默认 `./data`，`ONSTAGE_SECURE_COOKIE` 默认 1，`ONSTAGE_VERSION` 为构建标识。不再读取 `ONSTAGE_INVITE_CODE`。

默认限额由服务器在事务内执行，返回 429 并给出 Retry-After：

| 对象 | 默认限制 |
| --- | --- |
| 新匿名会话 | 每来源 IP 60 次/分钟、300 次/小时；全站最多 500 个未撤销且未过期会话；恢复已有会话不占创建次数 |
| 建房 | 每会话 4 次/小时、每来源 IP 20 次/小时；每会话最多 2 个未结束房间，全站最多 10 个 |
| 房间成员 | 最多 30 名当前成员；每房最多保留 150 个不同成员身份 |
| 举报 | 每会话 5 次/小时；同一目标的相同未结举报重试返回原回执，不重复计数 |
| 正文与贴纸 | 两类消息合计每会话每分钟 60 条，重试已入库消息不重复计数 |
| Python WS | 全站 100 个连接，每会话最多 6 个；在线人数按成员去重 |
| Sites 在线心跳 | 每会话最多 6 个有效页面连接；按成员去重，45 秒 TTL；具体 HTTP 传输见本文 Sites 扩展 |

会话／建房／举报频次记录写入对应业务数据库（Python 为 SQLite，Sites 为 D1），进程重启不会清零当前窗口。Python 的 IP 由应用所见的可信客户端地址确定，部署须核对反向代理信任范围；Sites 使用 Workers 提供的 CF-Connecting-IP，并仅保存其哈希。不自行相信客户端提供的 X-Forwarded-For。匿名会话封禁不等于防止换浏览器或更换网络。公开入口不是无限容量社区。

## 目录

`GET /api/catalog` 返回 `bands`、`characters`、`scenarios`、`stickers` 及贴纸筛选元数据，需匿名会话。保留两团、十个固定角色 ID。场景从 `app/catalog.json` 读取，不硬编码场景数量；各场景角色范围以 `character_ids` 为准，允许 `prompts=[]`、`ending_hint=""`。原有三个场景 ID 保留兼容旧房间。

贴纸目录项为 `{id,label,character_id,image,keywords,band_id?,source_pack?,source_category?}`。ID 唯一，id/label 各为 1–80 字符，image 仅为本域 `/static/` 下的资源路径。`character_id` 为十个固定角色 ID 之一；没有对应出演角色的补充素材允许显式 `null`，此时必须提供非空、最多 40 字的 `source_category`。未知的非空角色 ID 仍被拒绝，补充素材不能增加或占用出演席位。两项可选来源字段存在时须为非空、最多 80 字的字符串。

`0.4` 目录保留 143 个唯一贴纸 ID。`source_pack="user-v04"` 为本次提供的 123 张；默认选择器展示这一组。`source_pack="starter-v03"` 为另外保留的旧版 20 张，选择“全部”可见。原有 40 个 ID 与原图片路径全部保留，其中 20 张字节相同的 Ave Mujica 图片复用到本次素材组。`source_category` 保留用户的 11 个原目录名；“真奈”5 张为独立素材分类、`character_id=null`。同名但像素不同的图片不按名称自动合并。目录改名不重写历史快照。

`sticker_packs` 提供按乐队／补充素材的数量；`sticker_sources` 为 `{id,name,sticker_count}`，`sticker_categories` 为 `{id,name,character_id,sticker_count,user_pack_count}`。这些是筛选元数据，不承担权限功能。浏览器可以按素材包、原分类与关键词筛选；任何有当前频道发言权限的房主/演员均可使用目录整包，素材人物不限制发送者，也不改变实际消息作者。服务端不接受上传图片、任意 URL 或由客户端提供的贴纸快照。

## 健康与会话

- `GET /healthz` → `{status:"ok",version}`。
- `GET /readyz` → `{status:"ready",schema_version:4}`，实际检查数据库。
- `POST /api/session` `{nickname?:string|null}`、`{}` 或空 body → `{authenticated:true,csrf_token,version,nickname:string|null,requires_nickname:boolean}`；新会话设置 Cookie，恢复会话不旋转 Cookie。有效会话改昵称的 CSRF 规则见上节。
- `GET /api/session` → 同上；无有效会话 401。
- `POST /api/logout` → 撤销会话并清 Cookie，返回 `{ok:true}`；不删除历史，不自动释放所有房间席位。房主应先结束并离房。

## 房间与席位

- `GET /api/rooms` → `{rooms:[room]}`，最新最多 100 个房间。
- `POST /api/rooms` `{scenario_id,title?,background?,announcement?}` → `{room}`，同一事务建立未选角的房主成员并记录本人以观众身份加入的系统消息。房主仍有管理和后台资格，不会自动占角。title<=80，background<=2000，announcement<=500；省略 background 用目录 opening，显式空串表示空背景。
- `GET /api/rooms/{id}` → `{room}`。未入房可读基本信息；被本房移出者 403。
- `POST /api/rooms/{id}/join` `{}` → `{room}`。首次加入或正式离房后恢复为未选角观众，未结束房间追加一次加入事件；已在房间的重复请求不变更席位、不重复记事。被移出的匿名会话不能重入。
- `POST /api/rooms/{id}/leave` `{}` → `{ok:true}`，释放当前角色；房主须先结束。未结束房间为本次主动离场保存一条带当时昵称/角色名的系统消息，重复请求不再追加。Python 路径关闭该成员所有 WS；Sites 路径删除其心跳，后续同步按离场状态拒绝。
- `POST /api/rooms/{id}/characters/claim` `{character_id}` → `{room}`。服务端事务核验场景范围、角色唯一、当前阶段和 first_character_id。两个客户端抢同一空位只有一个成功，另一个 409；成功入席与角色入场事件同一事务提交，重复选择已占有的同角色幂等返回且不重复记事。结束后不允许选角。
- 旧 `/requests` 和 `/requests/{request_id}/decide` 路由已移除，返回 404；旧申请数据仅保留作迁移历史，不再参与操作。
- `POST /api/rooms/{id}/settings` `{background,announcement}` → `{room}`；两字段必填，房主独有，不修改 title，结束后 409。
- `POST /api/rooms/{id}/members/{member_id}/remove` `{}` → `{room}`；房主只能移出本房其他成员，不能移出自己，结束后 409。事务记录该房匿名 session 封禁，释放角色并离场；Python 路径立即关闭目标 WS；Sites 路径撤销目标活跃记录，后续同步、心跳和读写立即按封禁拒绝，前端在下一次请求得知。重复移出已封禁目标幂等成功。
- `POST /api/rooms/{id}/control` `{action:"start"|"pause"|"resume"|"end"|"open_join"|"close_join"}` → `{room}`。房主独有，至少两个已选角色才能开场。重复 start/end 不产生重复系统消息；结束后不能重开。

room: `{id,title,scenario_id,background,announcement,status,allow_join,revision,created_at,host_member_id,online_count,members,me}`。

member: `{id,alias,nickname,display_name,character_id,is_host,online}`；仅当前未离场成员。

me: `{member_id,nickname,is_host,character_id,first_character_id,can_stage,can_backstage,can_claim,can_manage_reports}`，未入房为 null。can_stage 仅 live 时房主/演员 true；can_backstage 为读取资格，即使 ended 仍按房主/现任演员为 true，发送另查未 ended；can_manage_reports 为本房房主。报告另有逐条 can_resolve，不能仅凭房主身份猜测。

## 消息与恢复

- `POST /api/rooms/{id}/messages` 继续使用同一端点。文字请求为 `{channel:"stage"|"backstage",text,client_message_id,content_type?:"text"}`；省略 content_type 默认 text，原请求无需修改。text 为 1–2000 字且不能全空白，不能同时提供非 null 的 sticker_id。
- 贴纸请求为 `{channel:"stage"|"backstage",content_type:"sticker",sticker_id,client_message_id}`。sticker_id 必须是当前目录中的 ID；text 只能省略或为 `""`，不能混入文字、URL、作者信息或客户端快照。未知 ID、类型或不合法字段组合返回 422。请求不接受 `kind` 字段。
- client_message_id 为 8–80 字符。同用户同房同 ID、频道、内容类型及相同正文/贴纸 ID 重试返回原消息；不同类型、正文、贴纸 ID 或频道返回 409。贴纸幂等重试保留原发送时快照，即使该 ID 后来下架也能恢复原确认；下架 ID 不能用于新消息。重试仍须当前会话、本房成员及后台读取资格校验，不能借旧消息 ID 越权。
- 两类内容走相同事务、当前角色/阶段/频道权限、频率限额、分页游标和重连补齐；ended 后不能产生新消息。发送者信息由服务端决定，未知字段返回 422。
- `GET /api/rooms/{id}/messages?channel=stage&after=0&limit=100` → `{messages,cursor,has_more}`。必须有效本房成员，后台另核资格，观众直接读后台 403。
- `GET /api/rooms/{id}/sync?after_stage=0&after_backstage=0` → `{room,messages:{stage:[],backstage:[]},cursors:{stage:n,backstage:n},has_more:{stage:bool,backstage:bool}}`。每频道最多 100 条，cursor 是实际返回最后一条 seq，不是尚未交付的高水位。观众后台为空且 can_backstage=false。

message: `{id,seq,channel,member_id,character_id,author,text,created_at,client_message_id:string|null,kind:"speech"|"system",content_type:"text"|"sticker",sticker_id,sticker}`。保留旧 kind 含义：真人文字与真人贴纸均为 speech，系统消息仍为 system。

`client_message_id` 是兼容新增的对账字段：真人消息返回已持久化的请求 ID，系统消息为 null；POST、消息分页和 sync 使用一致结构。它不授予权限，不提供按该 ID 越权查询入口。客户端按身份范围、请求所在房间、实际 member_id、channel 和 client_message_id 精确确认；ACK 与 sync 共用同一逻辑，先对账再按服务端 id 去重。不得按正文、贴纸或时间猜测；POST 确认不推进分页游标。sync 先确认后，晚到 POST 错误不能倒退状态。每房最多保留一条待确认快照，允许继续编辑独立草稿；超时和后续重试拒绝保持“状态未确认”，原样重试使用原 ID 和原内容。

文字/系统消息的 content_type="text"、sticker_id=null、sticker=null，旧 text 内容不变。贴纸消息 content_type="sticker"，sticker 为发送时目录项的 `{id,label,character_id,image}` 不可变快照，text 固定为 `"[贴纸] " + label`，供旧客户端与缺图时回退。消息顶层 character_id/author 始终表示实际发送者；sticker.character_id 仅表示素材人物。历史按保存的快照显示，后续目录修改不会重写已提交消息或举报证据。资源文件仍应随版本保留；不可用图片通过 text 回退，不从客户端加载任意替代 URL。

### 房间事件与临时断线

加入、角色入场、主动离场和房主移出沿用上述消息结构，服务端写入 `channel="stage",kind="system",content_type="text",author="系统"`，member_id/character_id/sticker_id/sticker 均为 null。发生时的昵称（未命名时为观众序号）及角色中文名直接冻结在 text，不根据后来改名或退角重新生成，不增加可由客户端伪造的事件字段。

| 真实状态变化 | 保存的 text 示例 |
| --- | --- |
| 创建房间时本人加入，或首次/正式重入 | `小雨 以观众身份进入了房间。` |
| 成功占据角色 | `小雨 作为 长崎素世 入场。` |
| 有角色时主动离开 | `小雨（长崎素世）主动离开了房间。` |
| 房主移出有角色成员 | `小雨（长崎素世）已被房主移出房间。` |

无角色的离开/移出省略括号。移出事件不包含举报说明、处理备注或其他私有治理信息。事件与成员状态在同一互斥事务提交，使用既有 stage seq、分页游标、room revision 与 WS 同步通知，末条事件也能被其他客户端及断线恢复读取；不只在操作端临时显示。

正常 WebSocket 断开、重连、刷新及返回大厅不会产生主动离场/重新入场消息，也不释放角色。正式离场后再 join 才形成新的观众加入事件，再选最初角色形成新的角色入场事件；重试同一已完成操作不追加。ended 后加入或离开仅用于回看资格与成员状态，不向已结束的演出记录追加访客足迹。迁移不会倒填过去未记录的事件。

`WS /api/rooms/{id}/stream`：认证且已加入且未被移出，精确 Origin。接入/提交后 `{type:"sync"}`；客户端发字符串 `ping` 收 `{type:"pong"}`。重连后按 HTTP 游标补齐，周期性核对作为恢复机制。离房、移出、注销和到期关闭对应连接。跨房隔离，不在 WS 中传正文或业务指令。

## 举报、回执和处理

- `POST /api/rooms/{id}/reports` `{message_id?:null,reason:"harassment"|"spam"|"unsafe"|"other",details?:""}` → `{report}`。details<=1000；只允许本房有效成员提交。无 message_id 为举报房间，有 message_id 须确属该房且提交者此刻可读取该频道；不能借消息 ID 举报/读取其他房间或无权限后台。
- 提交时把消息全文和作者等（包括贴纸 content_type、sticker_id、sticker 发送快照），或房间 title/background/announcement，写成不可变快照。正文或目录后续变化不改该证据。旧举报快照不改写，缺少 content_type 时按 text 读取。
- 同一会话同房同一目标若已有 open 举报：同 reason/details 返回原回执；不同内容返回 409，避免无声覆盖。
- `GET /api/reports?after=0&limit=50` → `{reports,cursor,has_more}`，只返回自己所有房间的回执；离房/被移出后仍可查看自己的回执。
- `GET /api/rooms/{id}/reports?after=0&limit=50` → 同结构；本人可查看自己的本房回执，当前房主还可看普通举报。针对房间或房主消息的举报 `against_host=true`，不向房主暴露其他举报者的此类举报，房主无权处理。
- `POST /api/rooms/{id}/reports/{report_id}/resolve` `{status:"resolved"|"dismissed",note}` → `{report}`。note 为 1–500 字非空说明；仅当前房主可处理非 against_host 的 open 举报。已处理的相同结果/说明返回原记录，不同结果 409。处理只是带说明的结案，移出成员须单独执行相应操作。
- 房主相关举报通过服务器维护者私有 CLI 处理，没有公开管理员 API。结束后仍可进行举报与处理，不能据此编辑演出内容。

report: `{id,seq,room_id,target_type:"room"|"message",message_id,reason,details,status:"open"|"resolved"|"dismissed",created_at,resolved_at,resolution_note,resolved_by:null|"host"|"operator",against_host,is_own,can_resolve,snapshot,snapshot_redacted}`。

snapshot 为 `{message:message}` 或 `{room:{id,title,background,announcement}}`。若举报者后来失去后台资格，其后台举报回执仍可读，但 snapshot=null、snapshot_redacted=true；不会通过回执恢复后台读取权限。

私有 CLI：`python tools/moderate.py --data-dir DATA_DIR list [--status open|resolved|dismissed|all] [--after 0] [--limit 50]`；`python tools/moderate.py --data-dir DATA_DIR resolve REPORT_ID --status resolved|dismissed --note TEXT --operator LABEL`。只读/写已有 schema 4 本地数据库，处理写入私有操作者标签与时间。CLI 使用 Store.ready 核验当前结构，不自动建库或迁移。CLI 输出含举报正文，应在受限终端使用，不打包真实数据或复制到公开日志。

失联房主的房间可由维护者显式执行 `python tools/moderate.py --data-dir DATA_DIR end-room ROOM_ID --note TEXT --operator LABEL`。该操作写入 moderation_actions 私有审计和公开的系统结束消息，不伪造房主身份；重复结束已结束房间不重复写入。在线进程会在连接的周期性数据库检查中察觉版本变化并提示同步，HTTP 写权限在事务提交后立即遵守 ended。仅使用已授权的数据目录。

## schema 1 / 2 / 3 升级与验证

新库创建 schema 4。已有 schema 1、2 或 3 库在启动时先通过 SQLite backup API 写入独立的 `data_dir/backups/onstage-schema{原版本}-before-schema4-时间-随机.sqlite3`，验证完整性与原 schema 版本并限制权限；备份失败则不开始迁移。随后在一个 BEGIN IMMEDIATE 事务内迁移：schema 1 先补背景/公告、稳定显示称呼及相关治理结构，schema 1/2 均为 messages 增加 content_type、sticker_id、sticker_json，三类旧库都为 sessions 增加默认空 nickname，最后更新 schema_version=4。旧会话凭证及 CSRF 保持不变，旧网页会话可补昵称；不从历史角色或称呼推测用户昵称，不倒填加入/离开事件。旧库的 session、room、member、文字/贴纸 message、申请及已有举报/回执均保留，不重建消息主键或改写旧举报快照。任何中间步骤失败回滚整个事务。

升级前须停止旧业务进程并保留备份。schema 4 不能直接交给只认识 schema 1/2/3 的旧代码；回滚须停止新进程、保存升级后的现场，再选择匹配旧代码的迁移前备份和明确的恢复点。仅切换 release 不能完成跨 schema 回滚，恢复旧备份会失去该恢复点之后的新数据。

验证范围包括昵称身份恢复与 CSRF、事件事务与幂等、旁观/后台/移出边界、历史快照和末条通知、贴纸与文字兼容、严格载荷校验、频道/阶段/成员权限、幂等冲突、分页与断线恢复、举报快照、schema 1/2/3 保留和失败原子回滚。实际通过项目以同版原始报告为准，公网与浏览器设备仍需另验。

## 0.6 Sites 传输与维护扩展

### 能力协商与健康

Sites 的 `/api/session` GET／POST 在既有字段外返回：

```json
{
  "transport": {
    "type": "poll",
    "interval_ms": 1500,
    "presence_interval_ms": 15000,
    "presence_ttl_ms": 45000
  }
}
```

Python 响应没有此扩展时，前端继续原 WebSocket 路径。Sites 的 `/stream` 返回 426 和传输配置；客户端不尝试假 WebSocket，也不因选择轮询而显示连接故障。同步仍使用已有 `GET /api/rooms/{id}/sync?after_stage=N&after_backstage=N`，按实际收到的游标分页补齐，不能用服务器高水位跳过未读页。

Sites `/healthz` 另含 `backend:"sites-d1"`；`/readyz` 含 `schema_version:4,edge_schema_version:1,backend:"sites-d1",version`，真实检查数据库。版本、前端、Worker 和迁移以同一发布为准。

### 最近活跃状态

`POST /api/rooms/{id}/presence`，需有效匿名会话、CSRF、当前房间成员且未被移出。Body `{connection_id?:string,active?:boolean}`；connection_id 为每页随机 8–80 字符，省略时兼容默认连接键，active 默认 true。true 更新该连接的服务端时间，false 仅移除该连接。多人在线按成员去重，单个标签页离开不把同身份其他活跃页标为离线。

心跳有效期 45 秒；移出、正式离场或注销后不继续计入在线。浏览器挂起、断网导致心跳过期时显示暂离，但保留角色，不追加加入／退出系统历史。成功同步代表业务读取正常，与在线成员计数分别处理。Sites 没有进程内 WebSocket 连接数，不将该值包装为在线人数。

### 私有 operator API

以下扩展只在 Sites 后端启用，以 `Authorization: Bearer <ONSTAGE_OPERATOR_TOKEN>` 认证；凭据仅在服务端 runtime 配置。没有设置密钥时返回 503，错误或缺失凭据返回 401；不得在 URL 携带令牌。无 Origin 的命令行客户端允许访问；存在 Origin 时仍须精确同源。普通房主的 Cookie／CSRF 不授予这些权限。

| 方法与路径 | 参数与行为 |
| --- | --- |
| GET `/api/operator/reports` | `status=open|resolved|dismissed|all`，默认 open；after 默认 0；limit 默认 50，1–100；读取私有举报队列 |
| POST `/api/operator/reports/{id}/resolve` | `{status:"resolved"|"dismissed",note,operator}`；note 1–500 字非空白，operator 1–80 字非空白；保存处置回执与操作者标签 |
| POST `/api/operator/rooms/{id}/end` | `{note,operator}`，同上长度；记录运营结束原因和审计，原消息留存 |
| GET `/api/operator/export` | 一致业务版本的私有 JSON；保留稳定 ID、模式、消息游标、贴纸／举报快照与会话字段；有行数和体积边界，不提供截断成功 |

operator 导出包含身份相关字段和私有正文，不属于可公开 API 返回或源码包内容。CLI `tools/edge_operator.py` 将其写入新的受限文件；没有公开导入端点，实际恢复／迁库还需独立验证。
