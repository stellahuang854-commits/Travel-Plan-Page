# Phase 5：Cloudflare 私人旅行存储配置说明

## 当前代码中的资料结构

- 初始行程模板仍是根目录的 `trip-data.json`。它是静态包模板；Pages 构建脚本不会把它作为静态文件发布。
- 可编辑住宿、交通、餐厅和每日行程保存在按 `tripId` 隔离的旅行内容对象；运行时账单、同行者、To Do 和票据状态分别沿用项目现有集合。
- 本地模式继续使用 `localStorage`；附件继续采用 IndexedDB（数据库 `travel-plan-local-attachments`）。本阶段没有读取、清除或迁移浏览器里的资料。
- 云端状态表把旅行包、内容和运行集合保存在同一版本化状态中；附件元数据在 D1，文件对象在不公开的 R2 bucket。

## 已写入本地仓库的架构

采用 Cloudflare Pages Functions + D1 + 私有 R2 + Cloudflare Access。Pages Functions 与静态站同源，可使用 D1/R2 binding；Access 身份令牌在 API 中验证签名、受众和有效期。数据库与对象存储没有公开 URL。API 仍独立查询旅行成员关系，所以仅通过 Access 登录并不会自动授予旅行权限。

`worker/travel-api.mjs` 实现 API，`functions/api/[[path]].js` 提供 Pages Functions 入口。`functions/trip-data.json.js` 将原静态数据路径改为受保护的成员读取入口；`scripts/build-pages.mjs` 使用允许列表生成静态站，并排除 `trip-data.json`、源文件与测试目录。

### 权限

- Owner：读取和编辑全部旅行状态、创建/撤销邀请、变更/移除成员、导出备份、恢复状态历史及恢复附件。
- Editor：读取旅行状态，修改旅行包/内容/账单等运行集合，上传、替换和软删除附件。
- Viewer：读取允许共享的旅行状态及附件；API 拒绝所有写入。界面隐藏常见编辑入口，但安全边界是后端判权。
- 每个旅行 API 先验证 Access JWT，再用当前身份和路径中的 `tripId` 查询有效成员关系。成员移除后后续请求即被拒绝。附件对象通过随机私有对象键读取，不提供公开 bucket URL。

邀请链接为随机 256 位 token，仅存 SHA-256 摘要，有效期 1–30 天，可绑定邮箱、接受、拒绝、过期和撤销；接受后 token 不可再次使用。邀请链接只在创建时显示一次，由 Owner 自行通过私人渠道发送；当前未接入邮件服务。

并发编辑采用旅行状态 revision + `If-Match` 比较并交换；冲突返回 HTTP 409，提示刷新后处理，不静默覆盖。D1 保存每次历史版本；Owner 可以通过 API 列出版本并将历史状态恢复为一个新版本。附件使用软删除，Owner 可恢复。

## API 入口

- `GET /api/session[?tripId=…]`、`GET/POST /api/trips`
- `/api/trip/:tripId`：运行集合快照与更新
- `/package`、`/content`：旅行包及可编辑旅行内容
- `/backup`、`/revisions`、`/revisions/:revision/restore`、`/migrations`
- `/members`、`/invitations` 及邀请 inspect/accept/decline
- `/attachments`：列举、上传、读取、替换、软删除和 Owner 恢复

所有读取响应禁止缓存。API 错误不会输出旅行资料或凭证。写请求校验同源、负载大小、数据结构、`tripId` 和 revision。

## 安全迁移和备份流程

1. 在本机打开 `/cloud-export.html`，下载 JSON 备份。它包括行程包、内容、To Do、票据状态、AA 账单/同行者和该 tripId 的 IndexedDB 附件；导出不会上传或删除本机资料。
2. 配好并验证 Access、D1、R2 后，以 Owner 身份打开 `/cloud-import.html`。页面显示将导入的旅行与附件数量，并要求再次确认；只允许导入到空白云端旅行。导入失败时保留原备份和本机资料，可重试附件。
3. 云端可在 `/cloud-export.html` 下载 Owner 备份。恢复状态使用历史 revision API；恢复附件使用附件恢复 API。

此流程目前仅实现为本地代码；尚未使用真实 Cloudflare 账号或资源运行。除用户显式完成配置并确认外，不要执行远端迁移。先将 JSON 备份保存在本机安全位置。

## 需要账户所有者手动配置

Cloudflare 资源尚未创建。开始前需要在用户账号中：

1. 创建 Pages 项目（部署动作本阶段未执行），创建 D1 数据库和私有 R2 bucket。
2. 把 `wrangler.toml.example` 复制为 `wrangler.toml`，填写真实 D1 database ID 和 R2 bucket 名称。不要将密钥放入源码。
3. 在 Pages 项目绑定 `TRAVEL_DB` 与 `TRAVEL_ATTACHMENTS`，将 `migrations/0001_private_travel.sql` 应用到数据库。
4. 配置 Cloudflare Access 应用，保护整个站点路径 `/*`，并确保只有预期身份能登录。获取 team domain 与该 Access application 的 AUD。
5. 在 Pages Functions 环境设置 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`DEFAULT_TRIP_ID`。这些不是数据库管理密钥；Access AUD 仅用于验证令牌。不要将 D1/R2 管理密钥暴露到浏览器。
6. 核对 Access 静态资源保护、函数请求身份头和 Pages Functions 的 D1/R2 bindings 后，再用非真实旅行数据执行授权/越权验收。

`DEFAULT_TRIP_ID` 是当前首页模板适配的单旅行入口。成员可通过 `/api/trips` 查看其成员旅行；若需要一个账号使用多个旅行并在首页切换，需再实现选择器及对应加载流程。

## 本地检查与尚未验证的部分

- `npm run build:pages` 检查静态发布白名单；输出目录 `dist/` 不包含 `trip-data.json`。
- `npx wrangler pages dev dist` 需要先安装/提供 Wrangler 并设置本地 bindings。当前环境没有 Cloudflare 账号凭证或已配置 bindings，故未声称 Pages Functions、Access、D1、R2 已在 Cloudflare 实际运行。
- API 自动测试使用模拟身份、D1 仓储和 R2 bucket，覆盖匿名/伪造令牌、角色、跨旅行访问、并发 revision、邀请和附件访问；它们不替代真实 Cloudflare 集成测试。
- 浏览器本地预览仍是本地模式，不会验证私人云端端点。请不要把静态本地预览地址当成已启用访问保护的云站点。
