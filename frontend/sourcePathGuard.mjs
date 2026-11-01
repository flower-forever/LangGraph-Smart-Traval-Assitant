/**
 * 源路径大小写折叠冲突守卫（Node 内置模块实现，无第三方依赖）。
 *
 * 背景：Windows 文件系统大小写不敏感，TypeScript 在同一目录遇到
 * `Foo.test.tsx` 与 `foo.test.ts` 这类去掉扩展名后仅大小写不同的文件时，
 * 会把 .tsx 排除出编译程序，本地 tsc 假绿而 Linux CI 暴露真实类型错误。
 * 本库扫描源码目录内的 .ts/.tsx 相对路径，只检测这一类冲突：
 * 不读文件内容、不跟随 symlink、不做全仓 lint。
 */

import { readdirSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx'];

/** 扫描失败（目录不存在、读取被拒等）时抛出；必须让调用方看到，不允许静默略过。 */
export class SourcePathScanError extends Error {
  constructor(message, failures) {
    super(message);
    this.name = 'SourcePathScanError';
    this.failures = failures;
  }
}

/** 把任意路径分隔符正规化为 posix 风格，供比较与输出使用。 */
export function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

function hasSourceExtension(p) {
  const lower = p.toLowerCase();
  return SOURCE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function stripSourceExtension(p) {
  for (const ext of SOURCE_FILE_EXTENSIONS) {
    if (p.toLowerCase().endsWith(ext)) {
      return p.slice(0, -ext.length);
    }
  }
  return p;
}

/**
 * 递归收集 rootDir 下真实目录里的 .ts/.tsx 文件，返回 posix 风格相对路径（排序、去重）。
 * - rootDir 本身先 lstat：若是 symlink/junction，按合同 fail closed 抛错，
 *   既不扫描链接目标也不返回假绿空列表；
 * - 目录项以 readdir(withFileTypes) 判定：symlink（无论指向文件还是目录）一律不当作源文件、不递归进入；
 * - 只看文件名形状，不读取内容；
 * - 任何 readdir 失败都会以 SourcePathScanError 抛出并附全部失败位置，绝不静默跳过。
 */
export function scanSourcePaths(rootDir) {
  let rootStat;
  try {
    rootStat = lstatSync(rootDir);
  } catch (err) {
    throw new SourcePathScanError(
      `扫描源码目录失败（1 处）：.: ${err.code || String(err)}`,
      [{ dir: '.', code: err.code || String(err) }],
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    const kind = rootStat.isSymbolicLink()
      ? 'symbolic link / junction（合同要求不跟随）'
      : `非目录（${rootStat.isFile() ? '文件' : '其它类型'}）`;
    throw new SourcePathScanError(
      `扫描源码目录失败（1 处）：. 拒绝 ${kind}`,
      [{ dir: '.', code: 'SOURCE_ROOT_NOT_REAL_DIR' }],
    );
  }

  const files = [];
  const failures = [];

  function walk(dir, prefix) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      failures.push({ dir: prefix || '.', code: err.code || String(err) });
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        // 不跟随：symlink 不是真实目录/文件，既不递归也不当作源文件。
        continue;
      }
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && hasSourceExtension(entry.name)) {
        files.push(rel);
      }
    }
  }

  walk(rootDir, '');

  if (failures.length > 0) {
    const detail = failures
      .map((f) => `${f.dir}: ${f.code}`)
      .join('; ');
    throw new SourcePathScanError(`扫描源码目录失败（${failures.length} 处）：${detail}`, failures);
  }

  const unique = [...new Set(files.map(toPosixPath))];
  unique.sort(compareStrings);
  return unique;
}

/**
 * 在给定的 .ts/.tsx 相对路径列表里找「去扩展名后大小写折叠相同」的冲突组。
 * - 分隔符先正规化；完全相同的同一路径重复出现不误报；
 * - 非 .ts/.tsx 条目忽略；
 * - 返回按 key 排序的组，组内路径也排序；不修改调用者传入的数组。
 */
export function findSourcePathConflicts(paths) {
  if (!Array.isArray(paths)) {
    throw new TypeError('findSourcePathConflicts 需要 path 字符串数组');
  }
  const byKey = new Map();
  const seen = new Set();
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new TypeError('findSourcePathConflicts 的每一项都必须是非空字符串');
    }
    const normalized = toPosixPath(raw);
    if (!hasSourceExtension(normalized)) {
      continue;
    }
    if (seen.has(normalized)) {
      continue; // 同一原路径重复列出：不算冲突。
    }
    seen.add(normalized);
    const key = stripSourceExtension(normalized).toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, []);
    }
    byKey.get(key).push(normalized);
  }
  const conflicts = [];
  for (const [key, groupFiles] of byKey) {
    if (groupFiles.length > 1) {
      const sorted = [...groupFiles];
      sorted.sort(compareStrings);
      conflicts.push({ key, files: sorted });
    }
  }
  conflicts.sort((a, b) => compareStrings(a.key, b.key));
  return conflicts;
}

/** 一步完成扫描 + 冲突检测。 */
export function checkSourcePaths(rootDir) {
  const files = scanSourcePaths(rootDir);
  const conflicts = findSourcePathConflicts(files);
  return { files, conflicts };
}

function compareStrings(a, b) {
  // 用码元比较而不是 localeCompare，保证输出与 locale 无关、逐字节确定。
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* CLI 逻辑（库内可复用；check-source-paths.mjs 只是薄入口）            */
/* ------------------------------------------------------------------ */

/** 解析 CLI 参数。空字符串的 --source-root 按显式坏参数拒绝，不静默回退默认根。 */
export function parseCliArgs(argv) {
  const args = argv.slice(2);
  let sourceRoot = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--source-root') {
      if (i + 1 >= args.length) {
        return { error: '--source-root 需要一个目录参数' };
      }
      sourceRoot = args[i + 1];
      i += 1;
    } else {
      return { error: `未知参数：${args[i]}（只支持 --source-root <dir>）` };
    }
  }
  if (sourceRoot !== null && sourceRoot.trim() === '') {
    return { error: '--source-root 不能是空字符串（请给出实际目录；缺失参数会扫描错误目录还显示绿色）' };
  }
  return { sourceRoot };
}

/** 默认扫描位置：frontend/src，由库文件自身位置定位，与运行 cwd 无关。 */
export function defaultSourceRoot() {
  // 本库位于 frontend/ 下，默认扫描 frontend/src；不依赖 process.cwd()。
  return resolve(dirname(fileURLToPath(import.meta.url)), 'src');
}

function suggestRenames(files) {
  return files.map((f) => `  ${f}`);
}

/**
 * CLI 主流程，返回退出码：0 无冲突 / 1 有冲突 / 2 参数错误或扫描失败。
 * 供测试进程内 import 调用；entry module 是否是「直接运行」不影响其可用性。
 */
export function runCli(argv, { output } = {}) {
  const emit = output ?? ((line) => console.log(line));
  const parsed = parseCliArgs(argv ?? process.argv);
  if (parsed.error) {
    emit(`check-source-paths：${parsed.error}`);
    return 2;
  }
  const sourceRoot = parsed.sourceRoot ? resolve(parsed.sourceRoot) : defaultSourceRoot();

  let result;
  try {
    result = checkSourcePaths(sourceRoot);
  } catch (err) {
    emit(`check-source-paths：扫描 ${toPosixPath(sourceRoot)} 失败：${err.message}`);
    return 2;
  }

  if (result.conflicts.length === 0) {
    emit(`check-source-paths：OK — ${sourceRoot} 下扫描到 ${result.files.length} 个 .ts/.tsx 文件，无去扩展名后的大小写折叠冲突。`);
    return 0;
  }

  emit(`check-source-paths：发现 ${result.conflicts.length} 组大小写折叠冲突（共 ${result.files.length} 个源文件）：`);
  for (const conflict of result.conflicts) {
    emit(`- 组键（去扩展名 casefold）：${conflict.key}`);
    for (const line of suggestRenames(conflict.files)) {
      emit(line);
    }
    emit(`  建议：这些路径去掉 .ts/.tsx 扩展名后仅大小写不同；在大小写不敏感文件系统上 TypeScript 会把其中之一排除出编译程序。请重命名以区分（例如加 Panel/域前缀后缀），保持每目录内唯一。`);
  }
  return 1;
}
