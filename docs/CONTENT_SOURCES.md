# Onstage 内容与来源

核对日期：2026 年 10 月 18 日。对应版本 `0.6.0-phase1` 的 `app/catalog.json`；内容沿用 0.5 官方原图与既有素材，目录和图片原始字节未因多人部署更改。本文件记录角色事实、场所名称、官网原图、原创内容与用户上传素材；最终路径、校验值及处理见 [ASSET_MANIFEST.json](ASSET_MANIFEST.json)，功能与部署验收见 [acceptance.json](acceptance.json)。文件解码与来源核对不代替浏览器或公网验收。

此前 `0.4` 的 Sites 固定评审页已于北京时间 10 月 18 日 12:32 首次成功发布；其版本 2 平台首页截图已核查，见 [首页截图报告](../reports/sites-home-platform-v04.json)。该截图早于本轮官网人物原图替换，不能作为 `0.5` 新素材已发布或已完成交互、窄屏、手机、大陆网络验收的证据。本轮原图文件证据见 [人物素材导入报告](../reports/official-portraits-v05-import.json)，页面与发布状态仍由 [SITES_ITERATION](SITES_ITERATION.md) 分别登记。

## 内容结构

0.6 继续保留 MyGO!!!!!、Ave Mujica 共十名角色和二十个自由场所。贴纸默认使用本次用户上传的 123 张，按原 11 个目录分类；保留旧版补充后共有 143 个不重复资源与目录 ID。每个场所均可选择全部十名角色；场所不限制所属乐队、就读学校或既定人物关系。房主自行填写本场故事背景与公告，参与者自行决定发生什么。

`opening` 只有简短环境描写，`prompts` 为 `[]`，`ending_hint` 为空字符串。目录没有预设冲突、任务、结局、演出倒计时或自动角色回复。角色 `description` 仅保留乐队归属与声部的短句，不教玩家应该说什么，也不绑定旧版排练情节。

人物与场所图只负责视觉呈现，贴纸由参与者手动发送。贴纸上的人物不是额外出演者，完整服务的发送者仍以服务端保存的实际角色为准；显式离线评审适配器的本地操作身份与正式 Sites／Python 服务数据分开。“真奈”仅是用户包的补充分类，不新增可出演角色。基础姓名、乐队及地点信息可能包含轻微剧透；房主若采用更后的原作关系、时间线或 AU，应在本场背景／公告中自行说明，目录不默认为玩家公开完整剧情。

## 角色基础资料

基础来源为官方 [MyGO!!!!! 角色总览](https://anime.bang-dream.com/mygo/character/) 与 [Ave Mujica 角色总览](https://anime.bang-dream.com/avemujica/character/)。`Vo.`、`Gt.`、`Ba.`、`Dr.`、`Key.` 分别对应主唱、吉他、贝斯、鼓、键盘；不据此推断固定主音或节奏吉他分工。

| 稳定 ID | 中文显示名 | 官方日文写法 | 乐队 | 声部 | 官方人物来源 |
| --- | --- | --- | --- | --- | --- |
| `mygo.tomori` | 高松灯 | 高松 燈 | MyGO!!!!! | 主唱 | [高松燈](https://anime.bang-dream.com/avemujica/character/tomori/) |
| `mygo.anon` | 千早爱音 | 千早 愛音 | MyGO!!!!! | 吉他 | [千早愛音](https://anime.bang-dream.com/avemujica/character/anon/) |
| `mygo.rana` | 要乐奈 | 要 楽奈 | MyGO!!!!! | 吉他 | [要楽奈](https://anime.bang-dream.com/mygo/character/rana/) |
| `mygo.soyo` | 长崎素世 | 長崎 そよ | MyGO!!!!! | 贝斯 | [長崎そよ](https://anime.bang-dream.com/avemujica/character/soyo/) |
| `mygo.taki` | 椎名立希 | 椎名 立希 | MyGO!!!!! | 鼓 | [椎名立希](https://anime.bang-dream.com/avemujica/character/taki/) |
| `mujica.uika` | 三角初华 | 三角 初華 | Ave Mujica | 主唱／吉他 | [三角初華](https://anime.bang-dream.com/avemujica/character/uika/) |
| `mujica.mutsumi` | 若叶睦 | 若葉 睦 | Ave Mujica | 吉他 | [若葉睦](https://anime.bang-dream.com/avemujica/character/mutsumi/) |
| `mujica.umiri` | 八幡海铃 | 八幡 海鈴 | Ave Mujica | 贝斯 | [八幡海鈴](https://anime.bang-dream.com/avemujica/character/umiri/) |
| `mujica.nyamu` | 祐天寺若麦 | 祐天寺 にゃむ | Ave Mujica | 鼓 | [祐天寺にゃむ](https://anime.bang-dream.com/avemujica/character/nyamu/) |
| `mujica.sakiko` | 丰川祥子 | 豊川 祥子 | Ave Mujica | 键盘 | [豊川祥子](https://anime.bang-dream.com/avemujica/character/sakiko/) |

`name` 为本项目的简体中文显示约定，`name_ja` 保存官方日文，身份以稳定 ID 为准。“长崎爽世”与“长崎素世”指同一角色；“祐天寺若麦”及“喵梦”等异译不拆成多个席位。本次没有声称核实了唯一的中国大陆官方译名。Ave Mujica 的舞台名也不建立重复角色实体。

舞台名映射为 Doloris／ドロリス＝三角初华，Mortis／モーティス＝若叶睦，Timoris／ティモリス＝八幡海铃，Amoris／アモーリス＝祐天寺若麦，Oblivionis／オブリビオニス＝丰川祥子。该对应本轮已从 [Our Notes 国际站 Ave Mujica 官方角色页](https://bdon.biligames.com/character/avemujica/) 引用的角色资源脚本核对。此前日文入口的直接请求仍返回 404；本轮原图实际取自可读取的 Our Notes 国际站，精确文件映射见下文。

## 二十个场所及事实边界

“原作中有该场所”与“本项目画面精确还原该场所”是不同结论。以下场景均用于自由 IF，具体陈设、光照、时段和取景为 demo 原创设计；有事实出处的名称也不强制原作剧情或人物组合。

| 场所 ID | 显示名称 | 类别 | 名称依据与原创范围 |
| --- | --- | --- | --- |
| `mygo_rehearsal` | RING 排练室 | 音乐 | 官方有 Live House「RiNG」；本项目自行描写排练空间 |
| `mujica_changeover` | 演出候场室 | 音乐 | 通用原创场所，不宣称某一官方场馆的真实室内布局 |
| `shared_greenroom` | RING 休息区 | 音乐 | 官方有 RiNG；休息区的具体陈设为本项目原创 |
| `hanasakigawa_school` | 花咲川女子学园 | 校园 | 官方名称「花咲川女子学園」；本图与 opening 采用奶油色／红砖校舍及樱树庭院，具体构图为 demo 原创 |
| `haneoka_school` | 羽丘女子学园 | 校园 | 官方名称「羽丘女子学園」；本图与 opening 采用白色校舍入口及前庭，具体构图为 demo 原创 |
| `tsukinomori_school` | 月之森女子学园 | 校园 | 官方名称「月ノ森女子学園」；中文写法为项目约定，步道与庭院陈设为原创 |
| `school_rooftop` | 学校天台 | 校园 | 通用原创场所，不指定某所学校允许进入天台 |
| `shopping_street` | 街边商店街 | 城市 | 通用原创街道，不绑定真实商店或原作事件 |
| `park_path` | 公园小径 | 户外 | 通用原创公园环境，不宣称取自某集或某座公园 |
| `station_square` | 车站广场 | 城市 | 通用原创站前空间，不绑定实际车站 |
| `riverside_walk` | 河畔步道 | 户外 | 通用原创河畔环境，不绑定原作相遇或争执桥段 |
| `mother_child_statue` | 母子鬼神像前 | 特别 | 沿用用户给定场景名称；尚未确认与官方地点的对应，按用户场景 IF 使用 |
| `planetarium` | 星象馆星空厅 | 特别 | 版权方第 10 话梗概明确出现天文馆；本图自行设计穹顶与座椅，不确认是某家现实馆的精确内饰 |
| `sunshine_aquarium` | 阳光水族馆 | 特别 | 丰岛区确认该水族馆在作品登场；本图采用运营方确有的屋顶“天空企鹅”展区作为构图参考，不声称对应某一集的同一镜头 |
| `hareza_steps` | Hareza 剧场外台阶 | 城市 | 丰岛区确认东京建物 Brillia HALL 周边在作品登场；台阶、玻璃立面与时段为原创构图 |
| `ring_live_stage` | RiNG 演出厅 | 音乐 | 官方 RiNG 场所的自由 IF 演出空间，与现有排练室、休息区区分；不宣称精确还原舞台布置 |
| `space_stage` | SPACE 舞台 | 音乐 | BanG Dream! 系列官方场所；本场采用不指定年代的开放空间 IF，不据此声称原作当前仍营业 |
| `ikeda_ferry_port` | 海岛渡轮码头 | 户外 | 当地酒店公开巡礼索引把 Ave Mujica 第 12 话与池田港关联；非版权方确认，本目录使用海岛泛称与原创 IF 画面 |
| `mikasayama_overlook` | 海岛山顶眺望台 | 户外 | 同一当地经营者索引提及三笠山山顶；不声称官方认证取景或精确地形，画面为海岛眺望 IF |
| `recording_studio_if` | 录音棚控制室 | 音乐 | 通用自由 IF，调音台、隔音玻璃和录音间为原创；不指定为某一集或 sumimi 专属录音棚 |

RiNG 与羽丘的名称可从 [《It's MyGO!!!!!》官方故事页](https://anime.bang-dream.com/mygo/story/) 的本轮搜索缓存核对；该页直接请求仍返回 404，没有声称本轮打开了完整页面或核对其场景图片。花咲川见 [椎名立希官方资料](https://anime.bang-dream.com/mygo/character/taki/) 与 [三角初华官方资料](https://anime.bang-dream.com/mygo/character/uika/)；月ノ森见 [长崎素世官方资料](https://anime.bang-dream.com/mygo/character/soyo/) 与 [若叶睦官方资料](https://anime.bang-dream.com/mygo/character/mutsumi/)。产品原有两处沿用用户给定的 `RING` 写法，新增演出厅使用官方原拼法 `RiNG`，两者指同一场所名称。

新增地点的原始出处：

- [Bushiroad 官方第 10 话梗概](https://note.com/bushiroad_pr/n/nfaaba24ad1a0)：核对天文馆这个地点类型；其中场面图只开放给指定 note 感想用途，本项目没有复用这些截图。
- [丰岛区关于 MyGO!!!!! 的公开发布](https://prtimes.jp/main/html/rd/p/000000060.000165139.html)：明确列出阳光水族馆及东京建物 Brillia HALL 等作品登场区域。
- [阳光水族馆“天空之旅”常设展区](https://sunshinecity.jp/aquarium/area/sky-journey.html)：核对屋顶企鹅水槽及城市天空的展示特点；设施事实不能单独证明该视角就是动画取景。
- [第一期动画官方 SPACE 资料](https://anime.bang-dream.com/1st/character/live-house-space/) 与 [官方故事页](https://anime.bang-dream.com/1st/story/)：核对系列场所名称，不把本场 IF 绑定到剧中营业时间。
- [Bay Resort Hotel 小豆岛的公开巡礼索引](https://bayresort-shodoshima.jp/activity/49/)：当地经营者列出 Ave Mujica 第 12 话的池田港与三笠山线索，属于公开地方资料，证据强度低于版权方或政府对作品地点的明确确认。

前三个 ID 为兼容旧数据库而保留；旧标题“排练室只剩十五分钟”“开场顺序临时调整”“雨停以前的候场室”不再作为新房间的预设剧情。保留 ID 只保证场景引用连续，不把已保存的历史消息改写成新剧情。

对“母子鬼神像前”，已检索到的第一方资料分别确认 [東京都交通局的“鬼子母神前”站名](https://www.kotsu.metro.tokyo.jp/toden/stations/kishibojimmae/) 和 [丰岛区的“雑司ヶ谷鬼子母神堂”名称](https://www.city.toshima.lg.jp/miryoku/index.html)。这些来源不足以证明用户说的神像等同于上述地点，因此不擅自纠正名称、不添加实际地址，也不声称是官方剧情的复现。

## 视觉参考与素材记录

| 原始来源 | 已核对的内容 | 本项目采用方式 |
| --- | --- | --- |
| [Our Notes：MyGO!!!!! 官方角色页](https://bdon.biligames.com/character/mygo/) 与 [Ave Mujica 官方角色页](https://bdon.biligames.com/character/avemujica/) | 两团十名角色的主立绘与同套导航头像；页面资源脚本中可逐人核对文件映射 | 0.5 使用官网提供的原始 PNG，头像和完整立绘分开加载，保留原分辨率与原始字节 |
| [Girls Band Party! 官方网站](https://bang-dream.bushimo.jp/) 与 [MyGO!!!!! 官方加入公告](https://bang-dream.bushimo.jp/news/20230916/post-315-2) | 游戏官方入口及 MyGO!!!!! 特设入口 | 作为视觉参考出处，不将其网页资产视为可直接复用的素材包 |
| [官方六周年更新页](https://anniv-bang-dream.bushimo.jp/6th/update/) | 官方介绍区域会话、3D 演出等展示内容 | 参考场所与人物结合的呈现思路；不引入节奏游戏或 3D 引擎 |
| [Live2D 官方刊载的 Craft Egg 制作团队访谈](https://www.live2d.com/business/interview/bangdream/) | 团队说明角色动画、细微动作与插画表现的制作思路 | 支持以人物插画和轻动作增加亲近感的设计方向；本项目头像微动不冒称完整 Live2D |

本版的明亮可爱二次元风格、默认浅色、可切换深色及头像轻动效，是当前用户要求和项目设计选择，不声称官方游戏采用同一套配色、组件或页面布局。乐队 `color` 也是项目配色，不是官方标准色。

部分日文官方网站的直接读取返回 404；本轮 Our Notes 国际站的两团角色页、角色资源脚本及二十个选定图片文件均实际读取成功。Live2D 访谈、Craft Egg 公告、JR 东海合作页和上述政府／交通页面的参考地位保持原样。角色原图的逐文件核对与本项目浏览器页面的视觉验收分别记录。

### 官方角色原图、场所与旧贴纸来源

| 资产 | 项目路径 | 图源与处理 |
| --- | --- | --- |
| 十名角色的官网头像 | `static/assets/characters/official-v05/*-avatar-*.png`，由 `avatar_image` 引用 | Our Notes 官网原生 165×210 导航图，十人使用同一资源系列；原文件不修改，界面用 CSS 取顶部正方形 |
| 十名角色的完整立绘 | 同目录的 `*-ournotes-哈希.png`，由 `image` 与 `detail_image` 引用 | 对应头像的官网原生 1800×2160 透明 PNG；同一人物、服装和姿势，详情呈现完整原图；无 AI 重绘、放大或重新编码 |
| Ave Mujica 合照 | `static/assets/bands/mujica.webp` | JR 东海正式合作页的公开宣传图，按原构图转换为 WebP |
| MyGO!!!!! 合照 | `static/assets/bands/mygo.webp` | [Comic Natalie 的 MyGO!!!!! 专题](https://natalie.mu/comic/pp/mygo01) 刊载的官方宣传图；资源负责人实际取得图片，专题文章请求返回 405，没有声称本轮阅读全文 |
| 二十处场所插画 | `static/assets/scenes/场所ID.webp` | 本项目原创生成的 IF 环境插画；不声称是官方内饰、真实学校平面或地标的精确复刻 |
| MyGO!!!!! 二十张贴纸 | `static/assets/stickers/`，具体路径由贴纸目录记录 | [公开包索引](https://laplace.live/suits/1720768297001) 指向的 Bilibili CDN 原始 PNG；另有 [B 站公开介绍页](https://www.bilibili.com/opus/954046729077915654) 可核对包的展示信息 |
| Ave Mujica 二十张贴纸 | `static/assets/stickers/`，具体路径由贴纸目录记录 | [公开包索引](https://laplace.live/suits/1744614814001) 指向的 Bilibili CDN 原始 PNG |

以上旧贴纸是两团各二十张的 0.3 原始包，均保留原始 PNG 与稳定 ID。0.3 已有逐张人物与标签核对记录；该记录只覆盖原四十张，不扩写为本次全部 123 张的逐图目视结论。源页标记按原文登记：Craft Egg 公告为 ©BanG Dream! Project ©Craft Egg Inc. ©bushiroad All Rights Reserved.，JR 东海合作页为 ©BDP。

### 0.5 十名人物的官网原图

来源是 [BanG Dream! Our Notes 官方国际站](https://bdon.biligames.com/) 的两团人物页面。两页引用同一个 [角色资源脚本](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/js/index.51df4583.js)；本轮只把脚本当文本读取，没有执行下载的脚本。已逐项核对其中的“人物键 → 资源变量 → 图片路径”：导航图对应 `Jo` 字典，主立绘对应 `at` 字典。十人的稳定 ID、姓名、乐队和声部保持不变，目录的 `source_url` 指向可访问的相应乐队官方人物页。

| 角色 | 官网原生头像 | 官网完整立绘 |
| --- | --- | --- |
| 高松灯（`mygo.tomori`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_tomori-takamatsu.79e3611a.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_tomori-takamatsu.977523e7.png) |
| 千早爱音（`mygo.anon`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_anon-chihaya.b36b901f.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_anon-chihaya.e07c0b66.png) |
| 要乐奈（`mygo.rana`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_rana-kaname.0f8024ca.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_rana-kaname.b50dc468.png) |
| 长崎素世（`mygo.soyo`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_soyo-nagasaki.6c56ab2a.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_soyo-nagasaki.74e6c623.png) |
| 椎名立希（`mygo.taki`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_taki-shiina.f3131b83.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_taki-shiina.91c59885.png) |
| 三角初华（`mujica.uika`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_uika-misumi.cc729908.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_uika-misumi.6b4aecb7.png) |
| 若叶睦（`mujica.mutsumi`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_mutsumi-wakaba.a8505191.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_mutsumi-wakaba.875fab0a.png) |
| 八幡海铃（`mujica.umiri`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_umiri-yahata.a204259b.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_umiri-yahata.eb4909d7.png) |
| 祐天寺若麦（`mujica.nyamu`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_nyamu-yutenji.10610d3f.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_nyamu-yutenji.1ad4e5ce.png) |
| 丰川祥子（`mujica.sakiko`） | [165×210 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/nav_sakiko-togawa.b67063a0.png) | [1800×2160 PNG](https://s1.biligames.com/fe-static/game-global-bangdreamon/character/static/img/img_sakiko-togawa.ee5f3825.png) |

全部二十个文件直接保存 HTTPS 响应的原始字节，没有重绘、放大、裁切或重新编码。十张完整立绘均为 **1800×2160 RGBA PNG**，十张官网导航图均为 **165×210 RGB PNG**；导航图保留官网原有底色。逐张目视核对确认头像与对应立绘采用同一人物、服装、姿势和插画系列。已有十张生成的 `portrait-v03.webp` 已从运行素材中移除，旧版本可在 Git 历史中追溯。

`avatar_width=165`、`avatar_height=210` 描述头像源，`image_width=1800`、`image_height=2160` 描述完整立绘。十人的 `avatar_crop` 均为 `{x:0,y:0,width:165,height:165}`，坐标相对 **`avatar_image` 的原生像素**；这是 CSS 显示取景，不改图片文件，也不把头像坐标套到完整立绘。每个框均在原图范围内，顶部正方形保留面部与肩部；实际浏览器排版仍需单独验收。

十张头像合计 **522,029 字节**，最大单张是祥子 **58,833 字节**。十张完整立绘合计 **9,819,220 字节**，最大单张是爱音 **1,411,219 字节**。头像与完整立绘分开加载，使十个头像本身使用约 0.52 MB 的源文件；这个数值是文件字节总和，不是浏览器实测加载时间或大陆网络测速。

精确本地路径、二十个源 URL、完整 SHA-256、尺寸、HTTP `Last-Modified`、实际下载 UTC 时间及头像配对见 [official-portraits-v05-import.json](../reports/official-portraits-v05-import.json)。文件下载日期为 **2026-10-18 UTC**；源响应的最后修改日期为 **2026-09-11**，没有把 HTTP 最后修改时间当作首次发表日期。来源页面的署名为 **©BDP ©FTK ©BUSHI ©BHK**；记录出处不代表本项目取得了额外的素材许可。

### 0.4 用户上传的《分类.zip》

本次新增来源为用户直接上传的 `分类.zip`，不是从上述公开索引重新抓取的一整包。原包 **3,514,638 字节**，SHA-256 为：

~~~text
e4de700b1c81f7a6e1384bc61ce30a97d1d54bb1bb3db457fbd6b3eeb9b223f2
~~~

包内有 11 个目录、123 个 PNG，原始图片合计 3,509,669 字节。所有图片均为 **162×162、单帧静态 PNG**，已逐文件解码、核对 CRC／SHA、尺寸、帧数及重复内容；未裁切、重绘、缩放或重新编码。122 张含透明像素，`真奈/五冠王3.png` 原本就是不透明橙色卡面，原样保留。抽样实看了四张用户图及一张旧图对照，未声称全部图均已逐张目视核验。

ZIP 的文件名未设置 UTF-8 标志；全部 134 个条目具有 CRC 有效的 Unicode Path 扩展，其中文名称与 GBK 解码一致。导入保留原分类和标签，交付路径使用稳定 ASCII 文件名。已检查无路径越界、绝对路径、符号链接、加密条目或规范化路径冲突，原包与图片字节保持不变。逐文件映射见 [user-stickers-v04-import.json](../reports/user-stickers-v04-import.json)。

| 用户原分类 | 本次默认张数 | 与已有角色的目录对应 |
| --- | ---: | --- |
| 乐奈 | 16 | 要乐奈，`mygo.rana` |
| 灯灯 | 15 | 高松灯，`mygo.tomori` |
| 爱音 | 16 | 千早爱音，`mygo.anon` |
| 立希 | 15 | 椎名立希，`mygo.taki` |
| 素世 | 16 | 长崎素世，`mygo.soyo` |
| 初华 | 8 | 三角初华，`mujica.uika` |
| 睦头 | 8 | 若叶睦，`mujica.mutsumi` |
| 海铃 | 8 | 八幡海铃，`mujica.umiri` |
| 喵梦 | 8 | 祐天寺若麦，`mujica.nyamu` |
| 祥子 | 8 | 丰川祥子，`mujica.sakiko` |
| 真奈 | 5 | 补充素材，`character_id=null`；不推断新角色身份 |

分类名与标签来自上传目录和文件名，既有十人的昵称映射沿用本项目已核对的角色约定。搜索使用原分类、文件名标签及这些既有角色显示名；不凭画面、文件名或文件夹推断作者。本包没有提供可核验的原始作者或许可证字段，来源记录保持为空，不补写推测。素材来源事实与真人消息作者分别保存。

本次 123 张中，20 张 Ave Mujica 图片与旧资源逐字节相同，复用原稳定 ID 和哈希路径；新增文件为 103 张。其余旧 MyGO!!!!! 二十张作为 `starter-v03` 的旧版补充保留。界面默认“本次 123”（`user-v04`），切换“全部 143”后可继续使用其中保留的旧版补充二十张。目录合计 **143 张：MyGO!!!!! 98、Ave Mujica 40、补充素材 5**；默认本次素材对应 **78／40／5**。相似图案或同名标签不能代替哈希去重，旧消息和举报快照也不随当前标签改写。

### 当前资产完整性

`catalog.json` 采用同源 `/static/assets/...` 路径，人物运行时不热链外站。官网人物原图更替完成后，当前共有 **185 张内容图片：2 张乐队图、10 张头像、10 张完整立绘、20 张场所图、143 张贴纸**，合计 **21,727,033 字节**。本轮二十张新原图的文件解码、路径、尺寸、哈希和人物配对见 [人物素材导入报告](../reports/official-portraits-v05-import.json)。此前的 [content-assets-v04.json](../reports/content-assets-v04.json) 只记录旧版素材状态；通过文件核对不等于实际页面加载或真机验收通过。

完整原图 URL、上传包对应关系、处理方式及场所生成提示词由 ASSET_MANIFEST 逐项维护。0.5 的人物头像与完整立绘使用本节记录的两套配对官网原文件，目录标记为 `official_original`。本次人物更替没有改变场所、贴纸目录或其文件；旧四十张贴纸的 ID、哈希路径和原始字节均保留，以支持已保存记录回看。0.3 的目录、素材清单和验收记录归档于 `reports/archive-v0.3/`，不替代本版证据。
