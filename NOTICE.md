# 来源与许可范围记录

本文件记录 Onstage 工程中代码、依赖和演示内容的来源边界。它不是许可证，不授予第三方素材的再分发权，也不表示维护者已经选择本项目的代码开源许可。拟公开源码的处理流程见 [OPEN_SOURCE.md](docs/OPEN_SOURCE.md)。

| 内容 | 来源与定位 | 公开源码时的处理 |
| --- | --- | --- |
| `app/`、`edge/`、共享页面及项目工具／测试中的自写实现 | Onstage 项目工程；具体修改可追溯到 Git 提交 | 等维护者确定代码许可、署名和贡献规则 |
| Python／JavaScript 依赖 | 依赖清单、锁文件以及各依赖自己的许可与包元数据 | 保留对应依赖声明；不将依赖声称为本项目原创 |
| `static/assets/characters/official-v05/` | BanG Dream! Our Notes 官方两团角色页及其图片文件；来源信用标记 `©BDP ©FTK ©BUSHI ©BHK` | 独立于本项目代码许可；公开内容包前另核对应素材条件 |
| `static/assets/bands/` | JR 东海合作宣传与 Comic Natalie 刊载的乐队宣传图，具体来源见内容文档 | 独立演示内容，不自动纳入代码许可 |
| `static/assets/stickers/` | 用户上传的分类素材包及已记录的公开贴纸资源，包含保留的历史 ID | 保存来源对应，不从“公开可访问”推定可整体再许可 |
| `static/assets/scenes/` | 项目生成的原创 IF 环境插画；场所名称与原创范围在内容文档中区分 | 资产许可由维护者单独确定；不声称是官方场景原图 |
| 网页品牌标识、配色和组件 | 本项目界面图形与实现，取材范围见视觉／内容说明 | 与第三方乐队 Logo 分开，维护者确定项目资产许可 |

角色名称、场所依据、逐文件路径、实际来源和校验值由 [CONTENT_SOURCES.md](docs/CONTENT_SOURCES.md) 与 [ASSET_MANIFEST.json](docs/ASSET_MANIFEST.json) 维护。第三方作品名称和信用标记用于标识来源，不表示官方合作或背书。历史测试数据与运行记录不会因放在同一工程里而成为可公开的社区数据集。

部署密钥、匿名凭据、真实聊天、后台记录、举报证据及私有数据库导出不属于源码发布内容。它们按维护流程受限保存，不进入公开仓库、静态目录或发布附件。

## 当前素材交付

仓库所有者于2026-10-18明确要求将原始美术随公开仓库交付完整部署。本仓库现包含原始185个素材文件，保留原路径、逐文件来源、权利信用和校验值，详见docs/CONTENT_SOURCES.md及docs/ASSET_MANIFEST.json。原始SOURCE_REVISION是历史来源；PUBLIC_SOURCE_PROVENANCE中的sample记录仅描述首次导出，当前content_mode为original-artwork。仓库所有者的发布指令不等于为第三方作品新增许可证，项目代码许可也不自动覆盖这些素材。
