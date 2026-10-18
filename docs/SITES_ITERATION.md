# Sites 真人多人服务与源码接续

对应源码：`0.6.0-phase1`。2026-10-18 15:48 北京时间，用户明确要求明天演示先使用 Sites 承载真正可用的多人服务。此前 0.4／0.5 的静态评审只是历史发布；新的正式构建包含 Workers 后端与共享 D1，不加载浏览器本地适配器。

## 同一项目与访问入口

| 项目 | 记录 |
| --- | --- |
| 项目 ID | `ONSTAGE_SITE_PROJECT_ID` |
| 固定 URL | [onstage-band-review.snowybeech7.chatgpt.site](https://onstage.example.org) |
| 访问范围 | 保持 `public`；访客填昵称，无需 ChatGPT 账号、密码、邀请码或验证码 |
| 源码 | 同一 Git 仓库 `onstage-site`，保留现有 Python 后端与共用前端 |
| 正式运行时 | Cloudflare Workers，TypeScript；D1 绑定 `DB` |
| 数据模式 | 业务 schema 4；额外 edge schema 1 保存共享协调与在线心跳 |
| 正式产物 | `dist/server/` Worker、`dist/client/` 静态资源、`dist/.openai/` 部署和迁移元数据 |
| 发布及验证状态 | 以 [acceptance.json](acceptance.json) 与本轮原生回执为准；不能由本地 build 成功推断已上线 |

域名中的 `review` 保留，避免打断已发链接；它不决定实际运行模式。真实模式以 `/healthz` 的 `backend:sites-d1`、`/readyz` 的数据库检查、会话返回的传输配置和独立会话探针为证据。

## 首次真实共享发布：Sites 保存版本 6

**共享服务已于 2026-10-18 16:19 北京时间发布成功。** 下表记录首次运行真实共享后端的发布，完整回执为 [publication-v06.json](../reports/publication-v06.json)。后续文档保存或重新发布可能增加 Sites 版本号；不能改写这次首次发布的历史，当前状态继续由 [acceptance.json](acceptance.json) 维护。

| 项目 | 首次发布记录 |
| --- | --- |
| 应用版本／Sites 保存版本 | `0.6.0-phase1`／`6` |
| 源码提交 | `8d3902356977bde7e18abb660fc8ef4c0a34487d` |
| 原生部署 ID | `appgdep_6ad480f69e0c81918e48d2e6b6d48e44` |
| 原生终态／UTC 时间 | `succeeded`／`2026-10-18T08:19:12.803858Z` |
| 生产内容与依赖校验值 | `3fbe079381987b91ce907f531dd60ea27261231941e3b773c698749ec32aaef4` |
| 线上运行结果 | `/healthz` 返回 `sites-d1` 与应用版本；`/readyz` 返回业务 schema 4、edge schema 1 |

公开 URL 上的 [共享协议探针](../reports/shared-http-public-v06.json) 已通过 11 组检查：四个独立昵称身份、135 次 HTTP 请求，验证共享房间、争抢角色、文字／贴纸、旁观与后台隔离、游标恢复、入退场、踢人及结束留档。测试房间已结束，测试会话已撤销；历史记录保留，不冒充自然用户数据。服务器声明 1500 ms 自动轮询、15000 ms 心跳和 45000 ms 在线有效期，配置值不等于真实手机消息延迟保证。

[维护者公开接口](../reports/operator-public-v06.json) 另有 13 条通过记录，覆盖缺失／错误凭据与异源拒绝、私有举报列表、测试举报处理回执、已结束房间的幂等维护和真实一致性导出。此次导出为 10 张业务表、17463 字节，只在内存验证格式和记录数，未保存私有正文或令牌。它与隔离 D1→SQLite 恢复验证共同构成迁出准备的证据，实际目标机迁移仍未执行。

[平台首页图像记录](../reports/sites-home-platform-v06.json) 对保存版本 6 的 1200×750 匿名首页进行了人工查看，昵称入口、粉青双星标识和浅色页面在此尺寸正常。该单张截图不覆盖房间操作、深色主题、中文输入法或实体手机。

公开 HTTP 验证使用执行环境已经配置的 HTTPS 代理，没有 Sites 访问绕过或 ChatGPT 登录。首次直接请求因本执行环境 DNS 失败而未收到 HTTP 响应，单独保留在 [开发网络记录](../reports/development-v06/shared-http-public-direct-dns.json)；它不是网站业务失败，也不能凭后续代理访问通过宣布大陆直连通过。大陆普通网络、实际手机及投资人现场继续按 [DEMO](DEMO.md) 实测。

## 共享内容与运行边界

| 路径 | 职责 |
| --- | --- |
| `static/`、`app/catalog.json` | 唯一共享页面、交互、标识和美术内容源 |
| `edge/handler.ts` | 同源 HTTP、校验、会话 Cookie、维护者认证与响应边界 |
| `edge/store.ts`、`edge/database.ts` | 业务规则与受版本守卫保护的 D1 原子批次 |
| `db/schema.ts`、`drizzle/` | D1 声明、生成 SQL 与不可改写的迁移历史 |
| `app/route.ts`、`build/`、`vite.config.ts` | 官方 Sites／Vinext 构建集成；根页直接使用共用 HTML |
| `app/*.py`、`app/schema.sql` | 保留的 Python／SQLite 独立服务，不在 Worker 内执行 |
| `scripts/prepare-static.mjs` | 从共用内容生成 `public/` 静态副本；不带评审适配器和业务数据库 |
| `preview/`、`tools/build_site_preview.py` | 明确生成的离线界面评审路径，默认输出 `dist-offline-review/` |

没有手工维护的第二套网页，也没有前端 localStorage 房间作为共享服务后备。正式连接失败时，界面显示同步问题并保留草稿，不能悄悄切回本机假联机。

所有共享写入先入 D1，成功后返回确认。跨实例一致性由数据库版本守卫和原子批次负责；HTTP 自动同步按消息游标补齐。在线心跳与业务席位分开，过期心跳不释放角色。后续传输、语言和部署变更需继续满足 [API_CONTRACT](API_CONTRACT.md)。

## 构建与迁移

带 Sites 插件的环境使用其官方 source helper、依赖安装和 build helper；保留 starter 的 `sites()` 集成。当前 manifest 移除了旧 `static` 项，声明 `d1:"DB"`、`r2:null`，复用既有项目与访问范围。

普通本地工作站需要 Node.js 22.13 以上（建议 24）及 Python 3.12：

```sh
npm ci
npm run db:generate
npm run build
```

`db:generate` 只在 schema 改动后需要执行。它生成的 SQL 与 Drizzle 元数据必须一并提交；已应用迁移不可重写。迁移只建立或调整结构，十个固定角色 ID、模式标识和协调初值由幂等初始化写入，不注入测试用户、房间或故事。

Sites 在上传 Worker 前应用待执行 D1 迁移。一次失败发布也可能已应用迁移，因此修复前要核对失败状态，不能因页面没更新就假定数据库没改。

普通本地工作站可按官方 starter 的方式将未执行迁移应用到独立本地 D1：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_rapid_edwin_jarvis.sql
npm start
```

不要重复执行已应用的建表迁移，也不要把本地 D1 当成线上 D1。托管 Linux 内部预览遵循 Sites 监督器与浏览器入口；环境不可用时记录未完成的浏览器验收，不替换基础设施来冒充通过。

## 运行环境

| 名称 | 设置 |
| --- | --- |
| `DB` | 由 Sites 根据 manifest 供应的 D1 绑定 |
| `ONSTAGE_PUBLIC_ORIGIN` | `https://onstage.example.org`，精确同源 |
| `ONSTAGE_VERSION` | 与当前部署对应的应用版本 |
| `ONSTAGE_OPERATOR_TOKEN` | Sites 中的 secret；不进入 manifest、前端、Git 或源码包 |

维护者凭据由服务端使用，普通房主不会获得。更改运行环境后需部署保存版本才生效。Sites 公开访问范围与应用访客身份相互独立；本项目按照用户明确要求保留匿名昵称会话，没有新建 OAuth 登录或账号系统。

## 验证与发布顺序

1. 打开同一项目源码，保留已有修改与业务数据；根据受影响内容更新版本、接口和文档。
2. 检查边缘业务、D1 并发、共享前端、Python 兼容及离线适配隔离。真实浏览器与手机独立记录。
3. 完成正式 build，检查 Worker、数据库绑定、迁移和所有内容；确认产物没有加载 `preview/adapter.js`。
4. 用 source helper 推送精确源码并打包对应产物。保存返回的版本，再部署该版本；轮询到原生终态。
5. 对成功返回的同一 HTTPS URL，用独立 Cookie 会话验证共享房间、消息、权限、恢复、入退场与踢人，记录实际服务器版本和清理结果。
6. 使用实际手机、大陆普通网络及演示现场网络进行彩排。其结果不能由云端 HTTP 探针或 DOM 检查代签。

上次静态站、当前 Worker 和浏览器本地数据库不能相互混为验证证据。0.5 历史回执仍保留在 `reports/sites-review-first-publication-v05.json`。

## 发布回退与后续迁出

明天演示必须保持真实共享服务。0.5 静态评审不满足这一要求，不能作为无说明的功能回滚。首次 Worker 候选若有缺陷，修复精确问题并重新发布；已有可用 Worker 版本后，才可在核对 schema 兼容性和运行环境版本后回退。

后续自有主机或语言迁移以服务端一致性导出为输入。先在隔离目标验证完整导入、ID、消息游标、角色和权限，再冻结旧入口写入、做最终导出并切换唯一主站。两边同名昵称不会自动合并，现有 Cookie 也不会自动跨域携带。详细边界见 [ARCHITECTURE](ARCHITECTURE.md) 和 [RUNBOOK](RUNBOOK.md)。

## 离线界面评审仍可单独使用

```sh
python tools/build_site_preview.py
node tests/preview_adapter_check.cjs reports/preview-adapter-local.json
```

产物是 `dist-offline-review/`；它明确标记浏览器本地，不运行 API／真实在线／举报维护。需要本地浏览器查看时由本机正常静态服务托管该目录。不要将此目录作为明天的多人服务发布，也不要把其中的本机操作导入为已有真实用户历史。
