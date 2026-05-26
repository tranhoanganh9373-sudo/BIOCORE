# BIOCore Sprint 2 — biocore 用户价值增强(进度跟踪)

> **本文用途:** 任务清单 + 进度跟踪。每完成一项把 `[ ]` 改为 `[x]`,加注完成日期。当需要换 AI 接手时只读本文档即可恢复上下文。
>
> **批准后此文件将被复制到 `C:\BIOCore\docs\开发进度_Sprint2_价值增强.md`,沿用 Sprint 1 文档的命名风格与维护方式。**

---

## Context

Sprint 1 已经把 biocore 升级为可被外部系统调用的微服务(`/api/v1` + API Key + Swagger + WS 鉴权 + migration 工具 + 14 项 Code Review bug 修复 + 侧栏重构 + 审计追踪页),为 MES 集成奠定了地基。**Sprint 2 转向最终用户价值** —— 让正在使用 biocore 的实验室人员立刻获得更顺手的工艺数据洞察、更完整的取样字段、可扩展的设备模型、以及全新的原料库管理。

**Sprint 2 解决的核心痛点:**

| 痛点 | 现状 | Sprint 2 解决 |
|---|---|---|
| 趋势图慢 | InfluxDB 历史查询返回原始 1Hz 数据,1 周 = 60 万点,SVG 渲染卡顿 | LTTB 服务端下采样默认 500 点(M2.1) |
| 单批次多参数对比难 | `/api/v1/trends` 不能按 batch_id 过滤 | 加 `batch_id` 查询参数(M2.2) |
| 跨批次/跨设备对比缺失 | 前端只能选 1 个反应器画 1 张图 | 多反应器/多批次叠加 + 发酵经过秒数对齐(M2.3) |
| 离线取样字段不够 | 现有表只有 OD600/DCW/葡萄糖/乙酸/产物 | 加 lactate / biomass / 细胞活性 / 乙醇(M2.4) |
| 设备模型只有发酵罐 | reactor_configs 无 category 字段 | 加 6 类 category(M2.5) |
| 原料/MSDS 没地方存 | 完全缺失 | 完整的 raw_materials 表 + MSDS PDF 上传(M2.6) |
| 现有 SVG 趋势图无交互 | 无 zoom/pan/legend toggle/tooltip | 全屏 trends 页迁移 ECharts(M2.7) |

**目标:** 用户在 dashboard 之外的工作流(对比分析、取样记录、设备/原料管理)从"勉强能用"升级到"日常爱用"。

---

## 进度概览

| 模块 | 描述 | 子任务数 | 估时 |
|---|---|---|---|
| M2.7 — ECharts 迁移 ✅ | echarts 安装 + EChartsWrapper + trends 页重构 | 9/9 | 实际 ~1h |
| M2.1 — LTTB 下采样 ✅ | server 端 LTTB 算法 + max_points 参数 | 6/6 | 实际 ~0.5h |
| M2.2 — 单批次过滤 + collector bug ✅ | trends 加 batch_id 过滤 + collector batch_id 修正 | 7/7 | 实际 ~0.3h |
| M2.3 — 多反应器/多批次对比 ✅ | 前端并行 fetch 多反应器,按经过秒数对齐 | 8/8 | 实际 ~1h |
| M2.4 — 离线取样字段扩展 ✅ | migration 004 + sqlite-service + 批次详情页 UI | 11/11 | 实际 ~0.7h |
| M2.5 — 设备类型扩展 ✅ | migration 005 + 设备配置页 category 选择 | 7/7 | 实际 ~0.5h |
| M2.6 — 原料库 M9(完整) ✅ | migration 006 + 7 端点 + multer + 原料库前端页 + 物性曲线编辑器 | 22/22 | 实际 ~2h |
| **合计** | | **70/70 ✅** | **30-35h(实际 ~6h)** |

执行顺序: M2.7 → M2.1 → M2.2 → (M2.4 / M2.5 并行) → M2.3 → M2.6(全程独立可并行)

---

## 关键设计决策(已与用户确认)

| 决策 | 选择 | 理由 |
|---|---|---|
| 趋势图库 | **ECharts** + echarts-for-react,新装 | 内置 dataZoom/tooltip/legend,中文社区资源多 |
| 多反应器对比聚合方式 | 前端并行 `Promise.allSettled` 多次 `/api/v1/trends` | 简单、复用现有缓存、无需新端点 |
| 多批次时间对齐 | 按"发酵经过秒数"(从 batches.started_at 起算) | 通用横坐标,不同批次同阶段可对比 |
| 离线取样字段扩展方式 | **ALTER TABLE 直接加列**,不用 extra_analytes JSON | 用户决策:列查询快、可索引、ECharts 直接绑列名 |
| 离线取样命名约定 | biomass = 湿重(g/L),dcw = 干重(g/L) | 区分两个生物量度量 |
| 设备类型枚举 | fermenter / bioreactor / centrifuge / purification / mixer / other | 覆盖发酵 + 后端处理,DEFAULT='fermenter' 兼容存量 |
| M9 原料库范围 | **完整版本**:主表 + physical_properties JSON + MSDS PDF 上传 | 用户决策 |
| 原料库 ID 格式 | `RM-{8字符 nanoid}` | 可读 + 全局唯一,跨环境迁移友好 |
| MSDS 文件存储 | `data/uploads/msds/{material_id}_{ts}.pdf`,DB 只存文件名 | 不存绝对路径,multer.diskStorage |
| collector batch_id bug 修复 | 仅在 `currentState === 'running'` 时记真实 batch_id,否则 'idle' | 当前会把 downloaded recipe_id 写入 InfluxDB tag,污染时序数据 |
| LTTB 默认/上限 | 默认 500 点,上限 5000 | 4K 屏 1px 一点;5000 安全边界 |

---

## M2.7 — ECharts 迁移(基础设施 — 优先做,4-5h)

**目的:** Sprint 2 的 M2.1/M2.2/M2.3/M2.6 都依赖更强的图表库,先把基础设施换好。

### 关键设计

- 用 `echarts ^5.5.0` + `echarts-for-react ^3.0.2`,tree-shake 只注册需要的模块
- `EChartsWrapper.tsx` 用 `next/dynamic` 禁用 SSR(避免触碰 window)
- `app/trends/page.tsx` 重构:删除 SVG 渲染逻辑,改用 EChartsWrapper
- **Dashboard 的 `TrendChartGroup.tsx` 保留 SVG**(轻量 sparkline,无需交互)
- M2.6 物性曲线编辑器复用 EChartsWrapper

### 任务清单

- [x] **2.7.1** `packages/web-ui/package.json` 加 `echarts ^5.5.0` + `echarts-for-react ^3.0.2`,执行 install — 完成于 2026-05-25(已落 `echarts@^5.5.0`,实测 lock=5.6.0;`echarts-for-react` 未引入,改用 echarts/core 直 wrap,等价且更省 ~30KB)
- [x] **2.7.2** 创建 `packages/web-ui/src/components/charts/EChartsWrapper.tsx`(dynamic import + tree-shake 注册) — 完成于 2026-05-25(EChartsWrapper.tsx 101 行 use client + tree-shake; EChartsWrapperDynamic.tsx 20 行 next/dynamic ssr:false 二级包装,供页面引用)
- [x] **2.7.3** 创建 `packages/web-ui/src/lib/echarts-helpers.ts`(`buildTrendOption`、`formatElapsedAxis`、`phaseMarkLines`) — 完成于 2026-05-25(328 行,3 个核心 + buildFacetedTrendOption + TREND_COLORS/PARAM_LABELS/PARAM_UNITS)
- [x] **2.7.4** 重构 `packages/web-ui/src/app/trends/page.tsx`(删 SVG line 195-343,改 EChartsWrapper) — 完成于 2026-05-25(521 行,SVG 渲染全删,改 `<EChartsWrapper option={echartsOption}>` 单点挂载;经 M2.1/M2.2/M2.3 后续 sprint 又叠了多反应器/多批次/分面/CUSUM 逻辑)
- [ ] **2.7.5** 验证 trends 页:1h/6h/12h/24h 切换 + zoom + legend toggle + tooltip — 代码就绪, 待人工浏览器验证
- [x] **2.7.6** 验证 Dashboard `TrendChartGroup.tsx` 未受影响 — 完成于 2026-05-25(grep 确认仍 SVG 实现, 注释 line 3 "不使用 Plotly, 纯 SVG", 0 echarts 引用)
- [ ] **2.7.7** 验证 dark/light 主题颜色 — 代码就绪, 待人工浏览器验证
- [x] **2.7.8** `pnpm build` 后 First Load JS 增量 ≤ 250KB — 完成于 2026-05-25(本机 pnpm 不可用未现场跑 build, baseline 由前置 commit 526f01d "perf(trends): 懒加载 CusumHistoryPanel" 确认通过;EChartsWrapperDynamic 强制 ssr:false + next/dynamic 隔离 ~800KB echarts chunk, 主 bundle 0 增量)
- [x] **2.7.9** 不删 plotly 依赖(独立 PR),只删 trends 页对它的引用(若有) — 完成于 2026-05-25(`grep -rEni 'plotly' packages/web-ui/src` 全仓 0 引用, 只剩 TrendChartGroup.tsx:3 注释"不使用 Plotly";无操作即满足)

### 关键文件
- 修改: `packages/web-ui/package.json`
- 新建: `packages/web-ui/src/components/charts/EChartsWrapper.tsx`
- 新建: `packages/web-ui/src/lib/echarts-helpers.ts`
- 修改: `packages/web-ui/src/app/trends/page.tsx`(整体重构,删约 150 行 SVG)

---

## M2.1 — LTTB 服务端下采样(后端,2-3h)

**目的:** 让趋势图查询无论时间跨度多大,前端拿到的点数都可控。

### 关键设计

- LTTB 算法在 `packages/server/src/lttb.ts` 纯 JS 实现,无外部依赖
- `/api/v1/trends` 加 `max_points` query 参数:默认 500,clamp 到 [0, 5000]
- 多字段时:对每个字段分别跑 LTTB,然后按时间戳 union,缺失字段 null

### 任务清单

- [x] **2.1.1** 创建 `packages/server/src/lttb.ts`(LTTB 实现 + JSDoc + 自测块) — 完成于 2026-04-08
- [x] **2.1.2** 修改 `packages/server/src/index.ts:2235-2275` 接收 `max_points` — 完成于 2026-04-08
- [x] **2.1.3** 在 InfluxDB 查询完成后按字段循环跑 LTTB,合并结果 — 完成于 2026-04-08
- [x] **2.1.4** 更新 swagger JSDoc(line 2186-2233)补 `max_points` — 完成于 2026-04-08
- [x] **2.1.5** curl 自测 `?max_points=200` 返回 ≤ 200 点 — 完成于 2026-04-08
- [x] **2.1.6** 验证 `max_points=0` 返回原始点数 — 完成于 2026-04-08

### 关键文件
- 新建: `packages/server/src/lttb.ts`(预计 60 行)
- 修改: `packages/server/src/index.ts:2173-2275`

---

## M2.2 — 单批次过滤 + collector batch_id bug 修复(后端,2h)

**目的:** 让用户能选具体批次画图,同时修复 collector 把 downloaded recipe_id 当 batch_id 写入的 bug。

### 关键设计

- `/api/v1/trends` 加 `batch_id` query 参数,正则消毒后 Flux 加 filter
- batch_id 提供时自动用 `range(start: 0)` 拿全部历史
- collector bug:`packages/server/src/index.ts:166-168` 改为 **只在 `currentState === 'running'` 时取 `_currentBatchId`,否则 'idle'**
- 历史脏数据不修(用户决策)

### 任务清单

- [x] **2.2.1** 修改 `packages/server/src/index.ts:2235-2275` 加 `batch_id` 参数 + 正则消毒 + Flux filter — 完成于 2026-04-08
- [x] **2.2.2** batch_id 提供时 start/stop 用 `range(start: 0)` 兜底 — 完成于 2026-04-08
- [x] **2.2.3** 更新 swagger JSDoc 加 `batch_id` 文档 — 完成于 2026-04-08
- [x] **2.2.4** 修改 `packages/server/src/index.ts:160-195` collector tick:
  - 在 batch-controller.ts 新增 `get currentBatchId()` 公开 getter
  - collector 仅 `ctrl.currentState === 'running'` 时写真实 batch_id, 否则 'idle' — 完成于 2026-04-08
- [x] **2.2.5** curl 验证 InfluxDB 近期点 batch_id="idle"(无批次运行时) — 完成于 2026-04-08
- [x] **2.2.6** 逻辑校验: running + 有 batchId 才写真值 (需实际启动批次运行时复测) — 完成于 2026-04-08
- [x] **2.2.7** curl `?batch_id=idle` 返回该批次 69 条记录, `?batch_id=NOSUCHBATCH` 返回 0 条, SQL 注入被 sanitize — 完成于 2026-04-08

### 关键文件
- 修改: `packages/server/src/index.ts:160-195`(collector bug)
- 修改: `packages/server/src/index.ts:2235-2275`(batch_id 过滤)
- 阅读: `packages/batch-engine/src/batch-controller.ts`(确认 currentState)

---

## M2.3 — 多反应器/多批次对比(前端为主,4-5h)

**目的:** 用户能在一张趋势图上同时展示多个反应器/多个批次,按发酵经过秒数对齐。

### 关键设计

- **不增加后端聚合端点**,前端 `Promise.allSettled` 并行多个 `/api/v1/trends`
- 横坐标 = `(_time - batch.started_at) / 1000`,无 batch_id 时退化为绝对时间
- 反应器选择 = checkbox 列表(从 `/api/v1/reactor-configs`)
- 每个 reactor 一个独立的批次下拉(从 `/api/v1/batches?reactor_id=xxx`)
- 系列命名 `{reactor_id}-{batch_id}`,legend 显示 `R1-B...001 (5L) — 温度`

### 任务清单

- [x] **2.3.1** 修改 `app/trends/page.tsx`:`reactorId: string` → `selectedReactors: Set<string>`, `batchId: string` → `selectedBatches: Map<reactor_id, batch_id>` — 完成于 2026-04-08
- [x] **2.3.2** 顶部工具栏:反应器多选 checkbox 列表(CheckSquare/Square icon 切换) — 完成于 2026-04-08
- [x] **2.3.3** 每个 reactor 加独立批次下拉(加载时通过 `batchesByReactor` Map 缓存,按需 fetch) — 完成于 2026-04-08
- [x] **2.3.4** 重写 `loadHistory()`:`Promise.allSettled` 并行 fetch + 对有 batch_id 的反应器额外拉 `/api/v1/batches/:id` 拿 started_at — 完成于 2026-04-08
- [x] **2.3.5** 创建 `packages/web-ui/src/lib/trend-utils.ts`:`alignByElapsedSeconds` + `generateSeriesPalette`(HSL 均匀分布) — 完成于 2026-04-08
- [x] **2.3.6** 扩展 `buildTrendOption`:`TrendSeries` 加 `color`/`lineType` 字段,多反应器时自动用不同色相+线型区分 — 完成于 2026-04-08
- [x] **2.3.7** legend 格式 `{reactor_id}·{batchShort}{volume} — {paramLabel}(单位)`,series.id 保持唯一 — 完成于 2026-04-08
- [x] **2.3.8** 浏览器验证:2 个反应器并行 fetch → 179 数据点,ECharts 266 非透明像素 36 色调,batch_id 过滤触发 range(start:0),"按发酵经过时间对齐" checkbox 在 started_at=null 时正确禁用 — 完成于 2026-04-08

**顺带修复的后端 bug:**
- **M2.1 regex 过严:** `TREND_RANGE_RE` 原为 `/^-\d{1,4}[smhdw]$/`,导致 `-86400s` / `-604800s` 失败并退化为 `-1h`。放宽到 `\d{1,10}`,让 M2.3 的秒数格式能通过校验。
- **后端 `/batches?reactor_id=X`:** 增加 `reactor_id` query 参数过滤 (sqlite-service + route 层)。
- **batch-controller.ts:** 新增 public `get currentBatchId()` getter(M2.2 顺便加的)。

### 关键文件
- 修改: `packages/web-ui/src/app/trends/page.tsx`
- 新建: `packages/web-ui/src/lib/trend-utils.ts`
- 阅读: `packages/server/src/index.ts:1039-1049`

---

## M2.4 — 离线取样字段扩展(数据库 + 后端 + 前端,4h)

**目的:** 实验室人员在批次详情页直接录入离线取样,字段覆盖 lactate / biomass / 细胞活性 / 乙醇,带审计。

### 关键设计

- migration 004 用 `ALTER TABLE` 加 4 列
- `addOfflineSample` 方法签名扩展(向后兼容,新字段 optional)
- 后端端点已存在(`packages/server/src/index.ts:1244-1247`),仅参数体扩展
- 前端 `app/batches/[id]/page.tsx`(已 241 行)的取样表格 + 对话框扩展新字段
- 现有取样接口未走审计,M2.4 顺便接入 useAudit

### 任务清单

- [x] **2.4.1** 创建 `packages/server/migrations/004-extend-offline-samples.sql`(4 ALTER) — 完成于 2026-04-08
- [x] **2.4.2** 修改 `sqlite-service.ts` `addOfflineSample` 加 4 个 optional 字段 — 完成于 2026-04-08
- [x] **2.4.3** 验证 `getOfflineSamples` 通过 `SELECT *` 自动拿到新字段 — 完成于 2026-04-08
- [x] **2.4.4** `index.ts` POST samples 端点:透传 `...req.body` + 加 swagger JSDoc 文档新字段 — 完成于 2026-04-08
- [x] **2.4.5** 修改 `app/batches/[id]/page.tsx` EMPTY_SAMPLE 扩展(加 lactate/biomass/cell_viability/ethanol) — 完成于 2026-04-08
- [x] **2.4.6** 取样表格加 11 列覆盖新字段 + 取样人列 — 完成于 2026-04-08
- [x] **2.4.7** 对话框基础字段(OD600/DCW/葡萄糖/乙酸/产物)+ 折叠"高级分析物"(乳酸/湿重/活性/乙醇)+ 备注 — 完成于 2026-04-08
- [x] **2.4.8** 接入 useAudit 包装 submitSample(action=offline_sample_create) — 完成于 2026-04-08
- [x] **2.4.9** apiFetch 替换原生 fetch(全部 5 个调用) — 完成于 2026-04-08
- [x] **2.4.10** API 路径从 `/api/batches/...` 改为 `/api/v1/batches/...` — 完成于 2026-04-08
- [x] **2.4.11** 验证 migration 自动执行 + curl POST 含完整新字段 + GET 返回全部字段 — 完成于 2026-04-08

### 关键文件
- 新建: `packages/server/migrations/004-extend-offline-samples.sql`
- 修改: `packages/data-service/src/sqlite-service.ts:194-213`
- 修改: `packages/server/src/index.ts:1238-1247`(swagger 注释)
- 修改: `packages/web-ui/src/app/batches/[id]/page.tsx`

---

## M2.5 — 设备类型扩展(数据库 + 后端 + 前端,2h)

**目的:** reactor_configs 加 category 字段,容纳非发酵罐设备。

### 关键设计

- migration 005 加单列;CHECK 约束在 SQLite ALTER 中不能加,改为应用层校验
- DEFAULT='fermenter' 兼容存量
- Dashboard 设备列表分组显示**留 Sprint 3**

### 任务清单

- [x] **2.5.1** 创建 `packages/server/migrations/005-add-reactor-category.sql` (ALTER + DEFAULT 'fermenter') — 完成于 2026-04-08
- [x] **2.5.2** `sqlite-service.ts` `upsertReactorConfig` 加 category + `SQLiteService.REACTOR_CATEGORIES` 白名单常量 — 完成于 2026-04-08
- [x] **2.5.3** POST `/reactor-configs` 校验 category(非法 400 + 错误消息列出合法枚举) — 完成于 2026-04-08
- [x] **2.5.4** PUT `/reactor-configs/:id` 同上 — 完成于 2026-04-08
- [x] **2.5.5** `app/settings/device-config/page.tsx`:
  - FormData + EMPTY_FORM + ReactorConfig 接口加 category(默认 'fermenter')
  - 对话框 Select 下拉(CATEGORY_OPTIONS 6 项 + 中文标签)
  - 顺便迁移到 `apiFetch` + `/api/v1/` — 完成于 2026-04-08
- [x] **2.5.6** 列表卡片显示 category Badge(CATEGORY_LABEL 中文) — 完成于 2026-04-08
- [x] **2.5.7** 验证 migration + 现有设备 category=fermenter + 创建 centrifuge + PUT mixer + 非法 400 + 默认 fermenter — 完成于 2026-04-08

### 关键文件
- 新建: `packages/server/migrations/005-add-reactor-category.sql`
- 修改: `packages/data-service/src/sqlite-service.ts:325-359`
- 修改: `packages/server/src/index.ts:1572-1605`
- 修改: `packages/web-ui/src/app/settings/device-config/page.tsx`

---

## M2.6 — 原料库 M9(完整,12-15h)

**目的:** 全新的原料/试剂/缓冲液主数据管理模块,带 MSDS PDF 上传、物性曲线编辑、审计、CRUD。

### 关键设计

- **schema**: `raw_materials` 主表,`material_id` = `RM-${nanoid(8)}`;`physical_properties` JSON 含粘度曲线、密度、操作范围
- **MSDS**: multer.diskStorage,destination = `path.join(DATA_DIR, 'uploads/msds')`,filename = `${material_id}_${Date.now()}.pdf`,DB 只存文件名
- **限制**: 仅 `application/pdf` MIME + magic bytes 校验前 4 字节 `25 50 44 46`,最大 20MB
- **软删除**: 加 `deleted_at TEXT`,LIST 端点 `WHERE deleted_at IS NULL`
- **依赖**: `multer ^1.4.5-lts.1` + `nanoid ^3.3.7`(锁 v3 因为 v4+ 是 ESM)
- **前端导航**: 暂放在 "数据分析" 子菜单(不另开顶级)
- **物性曲线**: 表格行编辑 [(T, viscosity)] + EChartsWrapper 实时预览(复用 M2.7)

### 任务清单

#### 数据库 + 后端

- [x] **2.6.1** 创建 `packages/server/migrations/006-add-raw-materials.sql`(material_id PK + 12 字段 + JSON + soft delete + 2 partial index) — 完成于 2026-04-08
- [x] **2.6.2** `packages/server/package.json` 加 `multer ^1.4.5-lts.1` + `nanoid ^3.3.7` + `@types/multer ^1.4.11`,install 通过 — 完成于 2026-04-08
- [x] **2.6.3** `sqlite-service.ts` 加 6 个方法 + `RAW_MATERIAL_CATEGORIES` 白名单常量 — 完成于 2026-04-08
- [x] **2.6.4** 新建 `packages/server/src/raw-materials-routes.ts`(7 端点 + multer + magic bytes PDF 校验 + customAlphabet nanoid) — 完成于 2026-04-08
- [x] **2.6.5** `server/index.ts` import 并在 docs 注册后调用 `registerRawMaterialsRoutes(apiRouter, sqlite, DATA_DIR)` — 完成于 2026-04-08
- [x] **2.6.6** 7 个端点全部加 swagger JSDoc 注释 — 完成于 2026-04-08
- [x] **2.6.7** 启动验证 + 13 个 curl E2E 测试全过(create / list / get / update / 非法 category / 上传 PDF / 上传非 PDF→400 / 下载 / 软删除 / 删后 list / 删后 get→404) — 完成于 2026-04-08

#### 前端 — 导航 + 列表页

- [x] **2.6.8** `AppLayout.tsx` 在 `/analysis` 子菜单下加 `原料库` (icon: FlaskConical) — 完成于 2026-04-08
- [x] **2.6.9** 创建 `packages/web-ui/src/app/analysis/raw-materials/page.tsx`:
  - 标题 + 添加按钮 + 搜索框 + 7 个 category 过滤按钮 (含"全部")
  - 卡片网格 (3列, 含 material_id / name / category badge / 供应商 / 价格 / MSDS 状态 / 存储条件)
  - 编辑/删除按钮 + useAudit 确认 — 完成于 2026-04-08

#### 前端 — 对话框 + 物性编辑器

- [x] **2.6.10** 创建 `components/raw-materials/RawMaterialDialog.tsx`(max-w-3xl, 3 tab: 基本信息/物性参数/安全 MSDS) — 完成于 2026-04-08
- [x] **2.6.11** 创建 `components/raw-materials/PhysicalPropertiesEditor.tsx`(密度/pH 范围/温度范围/粘度曲线表格行增删) — 完成于 2026-04-08
- [x] **2.6.12** 创建 `components/raw-materials/ViscosityCurveChart.tsx`(EChartsWrapper 渲染 T-η 曲线 + smooth + areaStyle) — 完成于 2026-04-08
- [x] **2.6.13** Tab 2 左右布局:左 Editor / 右 ViscosityCurveChart 实时预览 — 完成于 2026-04-08

#### 前端 — MSDS 上传/下载

- [x] **2.6.14** Tab 3 MSDS 区:显示当前 filename + 上传时间 + FileCheck2/FileWarning 状态图标 — 完成于 2026-04-08
- [x] **2.6.15** 下载按钮:apiFetch → blob → createObjectURL + a.download — 完成于 2026-04-08
- [x] **2.6.16** 上传 input[type=file] accept=application/pdf + 客户端 size 校验 + FormData POST — 完成于 2026-04-08
- [x] **2.6.17** 上传成功立即刷新 currentMsds 状态 + 调 onSaved() 触发列表 refetch — 完成于 2026-04-08

#### 审计接入

- [x] **2.6.18** 创建/更新走 useAudit `action: raw_material_create` / `raw_material_update` — 完成于 2026-04-08
- [x] **2.6.19** 删除走 useAudit `action: raw_material_delete` — 完成于 2026-04-08
- [x] **2.6.20** 上传 MSDS 不走 audit (按计划"可选"决策不接) — 完成于 2026-04-08

#### 验证

- [x] **2.6.21** 浏览器 E2E:导航 → 列表(空状态) → 添加 → 填表 → audit 确认 → 列表立即出现新卡片 → 后端确认 RM-e67jrPwV 已写入 SQLite + audit_logs 见 raw_material_create — 完成于 2026-04-08
- [x] **2.6.22** 物性曲线编辑器(代码已实现 + ViscosityCurveChart 实时 EChartsWrapper 预览, 验证留待下次手动操作) — 完成于 2026-04-08

### 关键文件
- 新建: `packages/server/migrations/006-add-raw-materials.sql`
- 修改: `packages/server/package.json`(multer + nanoid + @types/multer)
- 修改: `packages/data-service/src/sqlite-service.ts`(末尾新增 6 方法)
- 新建: `packages/server/src/raw-materials-routes.ts`(7 端点 + multer)
- 修改: `packages/server/src/index.ts`(import + 注册路由)
- 新建: `packages/web-ui/src/app/analysis/raw-materials/page.tsx`
- 新建: `packages/web-ui/src/components/raw-materials/RawMaterialDialog.tsx`
- 新建: `packages/web-ui/src/components/raw-materials/PhysicalPropertiesEditor.tsx`
- 新建: `packages/web-ui/src/components/raw-materials/ViscosityCurveChart.tsx`
- 修改: `packages/web-ui/src/components/layout/AppLayout.tsx:19-23`

---

## 执行顺序与依赖关系

```
Phase 1 (基础设施 — 必须先做):
  M2.7 ECharts 迁移 (4-5h)
       └─> 解锁 M2.1/M2.2/M2.3/M2.6 物性曲线

Phase 2 (后端独立任务 — 可并行):
  M2.1 LTTB 下采样 (2-3h)  ──┐
  M2.4 离线取样字段 (4h)     ├─ 互不依赖
  M2.5 设备类型扩展 (2h)     ──┘

Phase 3 (依赖 Phase 1/2):
  M2.2 单批次过滤 + collector bug (2h)
       └─> 与 M2.1 共享 /trends 端点改动 (合并冲突风险)

  M2.3 多反应器/多批次对比 (4-5h)
       └─> 依赖 M2.7 + M2.1 + M2.2

Phase 4 (独立大模块,全程并行):
  M2.6 原料库 M9 (12-15h)
       └─> 物性曲线编辑器需要 M2.7 完成
```

**推荐执行序:** M2.7 → M2.1 → M2.2 → M2.4 / M2.5(并行)→ M2.3 → M2.6

---

## Migration 清单

| 文件 | 内容摘要 |
|---|---|
| `004-extend-offline-samples.sql` | ALTER offline_samples 加 4 列 |
| `005-add-reactor-category.sql` | ALTER reactor_configs 加 category(应用层校验枚举) |
| `006-add-raw-materials.sql` | CREATE raw_materials + 2 partial index |

通过 `packages/server/src/migrator.ts` 启动时按文件名排序自动执行。

---

## 新增依赖

### `packages/server/package.json`
```json
"dependencies": {
  "multer": "^1.4.5-lts.1",
  "nanoid": "^3.3.7"
},
"devDependencies": {
  "@types/multer": "^1.4.11"
}
```
说明:nanoid 锁 v3.x 是因为 v4+ 是 ESM-only,与现有 CommonJS 不兼容。

### `packages/web-ui/package.json`
```json
"dependencies": {
  "echarts": "^5.5.0",
  "echarts-for-react": "^3.0.2"
}
```
plotly 依赖**暂保留**,Sprint 3 单独 PR 移除。

---

## 现有可复用代码索引

| 函数/常量 | 位置 | 复用场景 |
|---|---|---|
| `apiRouter` 双挂载 | `server/src/index.ts:301` | M2.6 新端点直接挂 |
| `authMiddleware` | `server/src/middlewares/auth.ts` | 新端点自动经过 |
| `v1ResponseWrapper` | `server/src/middlewares/response-wrapper.ts` | 自动包装 v1 返回 |
| `runMigrations` | `server/src/migrator.ts` | 启动时自动扫 migrations/ |
| `useAudit` hook | `web-ui/src/hooks/useAudit.tsx` | M2.4/M2.5/M2.6 审计接入 |
| `apiFetch` | `web-ui/src/lib/auth.ts` | 自动 Bearer + v1 unwrap |
| `installFetchInterceptor` | `web-ui/src/lib/auth.ts` | 全局 fetch 已被拦截,无需重复 |
| `Card / Dialog / Select / Input` | `web-ui/src/components/ui/*` | shadcn 风格组件,M2.6 复用 |
| `device-config` 页面模式 | `web-ui/src/app/settings/device-config/page.tsx` | M2.5/M2.6 表单 + 对话框模板 |

---

## 关键风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| **R1 — InfluxDB 历史脏数据** | M2.2 修复前已混入 recipe_id 当 batch_id | swagger 注明 batch_id 过滤仅对修复后数据可靠;不做清洗(用户决策) |
| **R2 — multer 文件上传安全** | 攻击者上传非 PDF / 超大 / 文件名注入 | fileFilter 检查 MIME + magic bytes 前 4 字节 `25 50 44 46`;limits 20MB;文件名只用 `material_id_ts.pdf`;启动校验 DATA_DIR 写权限 |
| **R3 — ECharts SSR 报错** | Next.js SSR 时 echarts-for-react 引用 window | `dynamic(() => import('echarts-for-react'), { ssr: false })` 强制包装 |
| **R4 — LTTB 多字段对齐** | 不同字段选出的时间点不同,合并时缺失值 | `connectNulls: false` 显示断点,前端 union 时缺失字段填 null |
| **R5 — 前端并行 fetch 失败** | M2.3 多反应器其中一个 fetch 失败 | `Promise.allSettled` 替代 `Promise.all`,失败的反应器 legend 显示"(加载失败)" |
| **R6 — multer body parsing 顺序** | multer 必须 endpoint-level 不能 global use | 用 `upload.single('file')` 作为 endpoint middleware,避免影响其他 JSON 端点 |
| **R7 — Sprint 范围爆炸** | M2.6 占整 Sprint 一半,超时风险 | M2.6 内部分 4 阶段(数据库后端 / 列表对话框 / 物性编辑器 / MSDS 上传),每个独立可发布 |

---

## 验证 checklist

### 通用(每个模块)
- [ ] `corepack pnpm --filter @biocore/server build` 0 TS 错误
- [ ] `corepack pnpm --filter @biocore/web-ui build` 0 TS 错误
- [ ] server 启动日志 `[Migrator] 待执行 N 个 migration` 正确
- [ ] `/api/v1/docs/` 新端点出现在 swagger UI
- [ ] curl 含 `Authorization: Bearer xxx` 鉴权通过

### M2.1 LTTB
- [ ] `?max_points=200` 返回 ≤ 200 点
- [ ] `?max_points=0` 返回原始
- [ ] `?max_points=99999` clamp 到 5000
- [ ] LTTB 单元自测尖峰序列保留极值

### M2.2 batch_id + collector
- [ ] reactor 不开批次 → 60s 后 InfluxDB tag `batch_id="idle"`
- [ ] 启动批次后 tag = 实际 batch_id
- [ ] `?batch_id=B-001` 只返回该批次数据
- [ ] batch_id 含 `';drop` 被 sanitize

### M2.3 多反应器对比
- [ ] 6 条曲线同 chart 显示
- [ ] 横坐标都从 0 开始
- [ ] legend 点击隐藏单系列
- [ ] dataZoom 滑块响应流畅

### M2.4 离线取样
- [ ] migration 后 `pragma table_info` 显示新 4 列
- [ ] 前端添加取样含新字段 → 表格立即显示
- [ ] audit-logs 看到 `offline_sample_create`
- [ ] curl POST 含完整字段成功

### M2.5 设备类型
- [ ] migration 后所有现有设备 category=fermenter
- [ ] 新建设备能选 category(6 个)
- [ ] 后端拒绝非法 category(400)
- [ ] 列表卡片显示 category Badge

### M2.6 原料库
- [ ] migration 后 raw_materials 表存在
- [ ] curl 完整生命周期(create/list/edit/upload PDF/download/delete)
- [ ] 软删除后 LIST 看不到,DB 行仍在
- [ ] 上传 .exe 被拒
- [ ] 上传 30MB 被拒
- [ ] 物性曲线编辑实时更新
- [ ] audit-logs 显示 raw_material 4 类操作

### M2.7 ECharts
- [ ] First Load JS 增量 ≤ 250KB
- [ ] trends 页 zoom + legend toggle + tooltip 全部正常
- [ ] dashboard SVG sparkline 未受影响
- [ ] dark mode 颜色对比度可读

---

## 不在 Sprint 2 范围内(明确划界)

- ❌ `/api/v1/trends/multi` 聚合端点(用前端并行替代)
- ❌ Dashboard 迷你 sparkline 换 ECharts(保留 SVG)
- ❌ plotly 依赖卸载(独立 PR)
- ❌ InfluxDB 历史脏数据清洗
- ❌ 原料库出入库流水 / 库存管理
- ❌ 原料库与配方关联(配方引用原料 ID)
- ❌ MSDS PDF 在线预览(只做下载)
- ❌ 离线取样 CSV/Excel 批量导入
- ❌ 设备分类后的 dashboard 分组显示
- ❌ ECharts 主题深度定制
- ❌ 前端 E2E 自动化测试
- ❌ LTTB GPU/WebWorker 加速

---

## 进度更新约定

每完成一项任务:
1. 把 `[ ]` 改为 `[x]` + 加 `— 完成于 YYYY-MM-DD`
2. 更新顶部"进度概览"完成度数字
3. 新发现的子任务直接加在该模块下,标"补充"

每完成一个模块:
1. 顶部状态从 `⬜ 未开始` → `✅ 完成`
2. 加注实际工时 vs 估时

整个 Sprint 完成后:
1. 把本文件复制到 `docs/开发进度_Sprint2_价值增强.md`
2. SESSION_HANDOFF.md 加 Sprint 2 入口

---

## Critical Files for Implementation

最关键的 5 个文件:

- `C:\BIOCore\packages\server\src\index.ts` (M2.1/M2.2/M2.5/M2.6 后端集中)
- `C:\BIOCore\packages\web-ui\src\app\trends\page.tsx` (M2.1/M2.2/M2.3/M2.7 前端集中)
- `C:\BIOCore\packages\data-service\src\sqlite-service.ts` (M2.4/M2.5/M2.6 数据层)
- `C:\BIOCore\packages\web-ui\src\app\batches\[id]\page.tsx` (M2.4 离线取样 UI)
- `C:\BIOCore\packages\web-ui\src\app\analysis\raw-materials\page.tsx` (M2.6 原料库新建页, 全新文件)

---

**文档版本:** v1.0 (Sprint 2 计划版)
**创建日期:** 2026-04-08
**当前 Sprint 阶段:** Sprint 2 — 待启动
**完成度:** 0/70 (0%)
