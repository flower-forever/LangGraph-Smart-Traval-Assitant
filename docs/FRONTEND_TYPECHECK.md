# 前端跨平台类型检查门禁（sourcePathGuard）

本文说明 ROADMAP 阶段 A 的类型检查可靠性小批：为什么本地 `tsc` 会在 Windows 上假绿、
这批做了什么来堵住它、命令怎么跑、检测边界在哪里。

## 真实复现：Windows 本地 tsc 漏检 .tsx

费用文件批次（trip-budget-transfer-release.md 第 48–52 行记录）首次 push（ec2e12d）时
CI 41254280272 的前端 job `pnpm build` 报了 7 处 TS 错误，本地却是绿的。根因：

- `frontend/src/__tests__/TripBudgetTransfer.test.tsx`（面板测试）与既有的
  `tripBudgetTransfer.test.ts`（纯函数测试）同目录，去掉扩展名后仅大小写风格不同；
  `SavedTrips.test.tsx` 与 `savedTrips.test.ts` 同理。不是两个 UI 文件互相重名。
- Windows 文件系统大小写不敏感，TypeScript 装载同名歧义时选择 `.ts` 而把 `.tsx`
  排除出编译程序（当时用 `tsc -p tsconfig.app.json --listFiles` 实测确认两个 .tsx
  均不在 program 里）。于是本地面板测试完全没被类型检查，错误全部涌到 Linux CI。
- CI 已在 2c6f2c6 修复那 7 处错误（删未使用导入/变量、`let release` 改 ref 对象），
  但命名冲突本身一直留在仓库里，本地漏检的机制没有变。

## 本批改动

1. **两个 UI 测试重命名**（内容/describe/断言/数量原样，仅文件名变化）：
   - `frontend/src/__tests__/SavedTrips.test.tsx` → `SavedTripsPanel.test.tsx`
   - `frontend/src/__tests__/TripBudgetTransfer.test.tsx` → `TripBudgetTransferPanel.test.tsx`
   对应的纯函数测试（`savedTrips.test.ts`、`tripBudgetTransfer.test.ts`）原样保留，
   每个目录内「去扩展名 casefold 后唯一」从此成立。
2. **新守卫工具**（Node 内置模块实现，零依赖、不改 lock 文件）：
   - `frontend/sourcePathGuard.mjs`：库。递归扫描给定目录（默认语义是 `frontend/src`）
     里的 `.ts`/`.tsx` 相对路径，分隔符正规化为 posix；只检测「去扩展名后大小写折叠
     相同」的冲突（同目录 `Foo.tsx`+`foo.ts`、同 case `foo.ts`+`foo.tsx` 都算）；
     不同目录同名、显式 `Panel` 后缀不误报；同一路径重复列出（含分隔符差异）不误报；
     不读文件内容、不跟随 symlink/junction；任何读取失败以 `SourcePathScanError`
     抛出，不允许静默跳过；输出按码元排序，确定、与 locale 无关，且不改调用者输入。
   - `frontend/check-source-paths.mjs`：CLI 薄入口。全部逻辑（参数解析、默认根定位、扫描、
     退出码）在 `sourcePathGuard.mjs` 里，入口本身**不做任何「是否直接运行」的判断**，
     import 即执行检查——entry 路径经 alias/junction/大小写差异时 `import.meta.url` 与
     `argv[1]` 可能不一致，任何入口判断都可能让真实检查被静默跳过（exit 0）。
     默认扫描位置由库的 `import.meta.url` 定位到 `frontend/src`，与运行 cwd 无关（在任意
     目录执行结果一致）；可用 `--source-root <dir>` 覆盖（空字符串按坏参数拒绝，exit 2，
     不静默回退默认根）。冲突时逐组列出原文件与改名建议，exit 1；扫描失败
     （目录缺失 / root 是链接等）exit 2；无冲突报告实际扫描文件数，exit 0。只读源码路径，
     不读 `.env`、不发网络请求、不写任何文件。
   - `frontend/sourcePathGuard.test.mjs`：Vitest 测试（纯 Node 语义，临时 fixture 放
     `os.tmpdir()` 仓库外，测完删除）。覆盖真实发生过的命名组合、分隔符/重复/确定性、
     symlink 排除（Windows 无特权时改用 junction 验证，含 rootDir 自身是链接的 fail closed）、
     扫描失败不假绿，CLI 的正/负/缺失退出码（进程内）与**真实子进程执行**：
     仓库内/外正负 fixture、`--source-root` 空串拒绝、以及经 junction alias 路径调用 CLI
     面对真实冲突 fixture 仍必须非零退出（回归独立验收发现的旧版 alias 静默跳过问题）——
     不靠进程内调用推断 CLI 有效。
3. **`frontend/package.json` 仅 scripts 变化**（依赖/version/tsconfig/CI workflow 不动）：
   - `build`：原 `tsc -b && vite build` 之前加 `node check-source-paths.mjs`——CI 的
     `pnpm build` 从此自动跑守卫，Linux/Windows 都在编译前先拦命名冲突；
   - 新增 `check:source-paths`：单独跑守卫；
   - 新增 `typecheck`：守卫 + `tsc -b --force --pretty false`（本地一键复现 CI 强制检查；
     `--force` 绕过增量缓存，避免陈旧 tsbuildinfo 假绿）。

## 命令

```bash
cd frontend
pnpm check:source-paths   # 只跑源路径守卫
pnpm typecheck            # 守卫 + tsc -b --force --pretty false
pnpm build                # 守卫 + tsc -b + vite build（CI 同款）
pnpm test                 # vitest run（含 sourcePathGuard.test.mjs）
```

## 检测边界（guard 管什么、不管什么）

管：`frontend/src` 下 `.ts`/`.tsx` 文件相对路径的去扩展名 casefold 冲突；扫描失败；
扫描根自身是 symlink/junction（拒绝扫描，不跟随链接目标也不假绿空列表）。

不管（刻意不做，避免扩成全仓审计）：非 src 目录（`dev-stub/`、仓库根脚本等）、
`.js`/`.jsx`/`.mjs` 等其它扩展名、文件内容与编码、依赖审计、`.env`、lint 规则。
它也不是类型检查本身——类型错误仍由 `tsc -b` 报；guard 只保证「所有 .ts/.tsx 都真的
进了编译程序」这一前提在两个操作系统上同时成立。

## Windows 与 Linux 都纳入 UI 测试的验证办法

重命名只是消除了当前两组冲突，将来仍可能引入新的。验证某个 `.tsx`（尤其 UI 测试）
真的在编译程序里，不依赖本地文件系统大小写行为的标准做法：

```bash
cd frontend
node node_modules/typescript/bin/tsc -p tsconfig.app.json --listFilesOnly | grep -F "你要核对的文件名"
```

`--listFilesOnly` 打印的是 TypeScript 实际装载的 program 文件清单：文件在里面，
它的类型错误才可能被 `tsc -b` 发现。仓库另有 `sourcePathGuard.test.mjs` 在每次
`pnpm test` 时用真实目录语义重放冲突/合法形状，`pnpm build`（CI）则在编译前先跑
守卫，三层一起把这类漏检拦住。

## 本批验证记录（离线，全部实际执行）

- `sourcePathGuard.test.mjs`：28 项全部通过；
- CLI 实跑：仓库内（94 个源文件）OK exit 0；仓库外 `%TEMP%` 冲突 fixture
  （`TripBudgetTransfer.test.tsx` + `tripBudgetTransfer.test.ts`）exit 1 并逐组列出；
  目录缺失 exit 2；`--source-root` 空字符串 exit 2；经 junction alias 路径调用 CLI
  面对真实冲突 fixture 仍 exit 1（旧版此处静默 exit 0，独立验收发现后已修）；
  在 `frontend/` 与 `%TEMP%` 两个 cwd 下执行输出一致；
- 重命名后两个 UI 测试原样跑通（13 + 36 项），费用与导入邻接回归通过，
  完整前端 suite 一次全量通过（数量见 implementation 报告，不以旧 1053 推算）；
- `tsc -p tsconfig.app.json --listFilesOnly` 核对两个新 UI 测试与两个原纯函数测试
  均在 program 清单中；`tsc -b --force --pretty false` 与生产 `vite build` exit 0。
