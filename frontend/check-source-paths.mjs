#!/usr/bin/env node
/**
 * CLI 薄入口：无条件执行源路径大小写折叠冲突检查，然后退出。
 *
 * 全部逻辑（参数解析、默认根定位、扫描、退出码）都在 sourcePathGuard.mjs 里，
 * 供测试 import；这里不再做任何「是否直接运行」的入口判断——
 * entry 路径经过 alias/junction/大小写差异时 import.meta.url 与 argv[1] 可能不一致，
 * 任何判断都可能让真实检查被静默跳过（exit 0），所以直接执行是唯一安全语义。
 *
 * - 默认扫描 frontend/src（由库的 import.meta.url 定位，与 cwd 无关）；
 *   可显式传 `--source-root <dir>` 覆盖（供负 fixture 等受控测试使用）；
 * - 发现冲突：列出每组原文件与改名建议，exit 1；
 * - 参数错误 / 扫描失败（目录缺失/不可读/root 为链接等）：exit 2；
 * - 无冲突：报告实际扫描到的文件数，exit 0；
 * - 只读项目源码路径，不读文件内容、不读 .env、不发网络请求、不写任何文件。
 */

import { runCli } from './sourcePathGuard.mjs';

process.exitCode = runCli();
