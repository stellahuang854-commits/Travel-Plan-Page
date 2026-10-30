# Phase 5：公开访问的单旅行站点

## 当前部署模式

网站公开访问，不使用 Cloudflare Access、登录身份、邮箱验证码、成员邀请或 Owner/Editor/Viewer 权限。任何访问网站的人都能读取旅行资料，并且可通过现有页面编辑资料；API 的写请求仍检查同源 Origin 以降低跨站请求风险，但它不是身份认证，也不阻止访客直接访问同源 API。因此请把这里的数据视为公开资料，不要保存不希望公开的个人信息。

Pages Functions、D1 和 R2 架构保留。`TRAVEL_DB` 连接旅行包、旅行内容、AA、To Do、票据和版本历史；`TRAVEL_ATTACHMENTS` 连接附件对象。R2 bucket 保持私有，不创建公开 URL；附件通过 `/api/trip/:tripId/attachments/...` Pages Function 流式读写。由于网站公开，附件 API 本身也公开可用，不再有成员级权限。

## 旅行包加载及持久化

- Pages Function 通过 Wrangler 的 Text module rule 将根目录 `trip-data.json` 打包为函数模块；原始文件不会被复制到 `dist` 公开静态目录。
- `/trip-data.json` Pages Function 优先读取 D1 中唯一已保存的旅行包，不要求 `DEFAULT_TRIP_ID`。如果 D1 还没有旅行包，则返回构建时读取的项目模板，不会自动写入 D1。
- 当前仓库模板的 `tripId` 是 `unconfigured`，标题为“旅行计划”，行程和旅行模块为空且模块关闭。它不是已填写的真实旅行资料。无云端旅行包时，页面会使用该模板及浏览器本地存储；每台浏览器的数据不会自动同步。
- API 只接受 D1 当前唯一旅行包中的 `tripId`，猜测其他旅行 ID 返回 404。如果 D1 存在多个旅行包，页面会报明确错误，不会自行挑选或覆盖。
- 以前的云端导入、成员和邀请 API 已禁用；成员管理、邀请、登录页面不会纳入 Pages 构建输出。迁移工具页面也不会发布。本次没有读取、上传、修改或删除浏览器本地资料/附件。

## D1、R2 与环境配置

仓库 `wrangler.toml` 已保留现有绑定：

- D1：`TRAVEL_DB` → `travel-plan-private-db`（database ID `0f21ffd7-f9a7-4de8-b93a-ec95a497c61b`）
- R2：`TRAVEL_ATTACHMENTS` → `travel-plan-private-attachments`

运行时不再读取 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 或 `DEFAULT_TRIP_ID`。除 Pages Functions 绑定的 `TRAVEL_DB` 和 `TRAVEL_ATTACHMENTS` 外，不需要新增环境变量或 secret。

如果 Cloudflare 账号之前为该 hostname 配置过 Access 应用，仍需由账号所有者在 Dashboard 中移除/关闭该 Access 策略；本地代码无法取消账号级的 Access 拦截。本次没有操作 Cloudflare 账号。

## D1 数据现状与限制

`0001_private_travel.sql` 只创建 D1 表结构，不导入旅行包或浏览器数据。当前仓库中的 `trip-data.json` 是未配置的空白模板。为避免未确认的持久化远程数据变更，Functions 不会自动用这个模板在 D1 创建旅行记录。若 D1 目前没有已保存的旅行包，网页能打开，但会进入空白模板的本地存储模式，尚未启用多设备 D1 同步；现有浏览器本地资料仍只在原浏览器中。旧 schema 中的成员/邀请表保留但 API 不再读取或写入。

显式初始化命令 `npm run initialize:public-trip` 只读取并验证仓库里的空白 `trip-data.json`，不读取浏览器 localStorage/IndexedDB。它先确认 `wrangler.toml` 中的 D1 名称和 ID 与已配置数据库一致，然后用 `INSERT OR IGNORE` 写入模板包、空运行集合和初始历史版本；任何已存在的旅行、状态或历史行都不会被覆盖。末尾查询会显示旅行 ID、持久化模式和 `day_count=0`。脚本不会应用 schema migration，也不会创建成员、邀请、附件或 R2 对象。这个命令会写入远程 D1，必须由用户显式运行；本地开发/测试不会自动调用它。

Pages Build command 为 `npm run build:pages`，输出目录 `dist`。构建产物不含公开静态 `trip-data.json`；需确认包含 `functions/` 的 Pages Functions 部署方式。部署后还需以公开模式验证 `/trip-data.json`、D1 API 和 R2 流式访问。
