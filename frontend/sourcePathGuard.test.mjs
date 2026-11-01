/**
 * sourcePathGuard / check-source-paths 的 Vitest 测试（纯 Node 语义，无 DOM）。
 *
 * 用真实目录语义覆盖实际发生过的命名组合与合同要求：
 * - 同目录同 case 的 foo.ts + foo.tsx（也是冲突）；
 * - 同目录仅大小写不同的 SavedTrips.test.tsx + savedTrips.test.ts（真实 CI 根因形状）；
 * - 不同目录同名 / Panel 后缀命名合法不误报；
 * - 分隔符正规化（反斜杠）、重复同一路径不误报、输出确定、不改调用者输入；
 * - 扫描失败（目录不存在）必须抛错而不是静默通过；
 * - CLI 以子进程真实执行：正 fixture exit 0、冲突 fixture exit 1、目录缺失 exit 2。
 *
 * 临时 fixture 一律放仓库外（os.tmpdir()），测完删除，不在仓库里残留。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  scanSourcePaths,
  findSourcePathConflicts,
  checkSourcePaths,
  SourcePathScanError,
  runCli,
  parseCliArgs,
  defaultSourceRoot,
} from './sourcePathGuard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, 'check-source-paths.mjs');

const tempRoots = [];
function makeTempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `source-path-guard-${label}-`));
  tempRoots.push(dir);
  return dir;
}

function writeSource(root, relPath, content = 'export {}\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('findSourcePathConflicts（纯列表语义）', () => {
  it('同目录仅大小写不同的 .tsx 与 .ts 报冲突（真实 CI 根因形状）', () => {
    const conflicts = findSourcePathConflicts([
      'src/__tests__/SavedTrips.test.tsx',
      'src/__tests__/savedTrips.test.ts',
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].key).toBe('src/__tests__/savedtrips.test');
    expect(conflicts[0].files).toEqual([
      'src/__tests__/SavedTrips.test.tsx',
      'src/__tests__/savedTrips.test.ts',
    ]);
  });

  it('同目录同 case 的 foo.ts + foo.tsx 也是冲突（跨扩展名）', () => {
    const conflicts = findSourcePathConflicts(['src/foo.ts', 'src/foo.tsx']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].key).toBe('src/foo');
    expect(conflicts[0].files).toEqual(['src/foo.ts', 'src/foo.tsx']);
  });

  it('不同目录同名不冲突；显式 Panel 后缀不与无后缀同名冲突', () => {
    const conflicts = findSourcePathConflicts([
      'src/__tests__/SavedTrips.test.tsx',
      'src/lib/savedTrips.test.ts',
      'src/__tests__/SavedTripsPanel.test.tsx',
      'src/__tests__/SavedTrips.test.tsx', // 同一路径重复列出
    ]);
    expect(conflicts).toEqual([]);
  });

  it('反斜杠分隔符正规化后与正斜杠等价判定', () => {
    const conflicts = findSourcePathConflicts([
      'src\\__tests__\\TripBudgetTransfer.test.tsx',
      'src/__tests__/tripBudgetTransfer.test.ts',
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].files).toEqual([
      'src/__tests__/TripBudgetTransfer.test.tsx',
      'src/__tests__/tripBudgetTransfer.test.ts',
    ]);
  });

  it('同一路径重复列出（含分隔符差异）不误报', () => {
    const conflicts = findSourcePathConflicts([
      'src/lib/format.test.ts',
      'src\\lib\\format.test.ts',
      'src/lib/format.test.ts',
      'src/lib/format.ts',
    ]);
    expect(conflicts).toEqual([]);
  });

  it('非 .ts/.tsx 条目被忽略，不参与冲突', () => {
    const conflicts = findSourcePathConflicts([
      'src/lib/foo.js',
      'src/lib/FOO.js',
      'src/lib/foo.json',
      'src/lib/foo.ts',
    ]);
    expect(conflicts).toEqual([]);
  });

  it('输出确定且不修改调用者输入数组', () => {
    const input = [
      'src/b.tsx',
      'src/B.ts',
      'src/a.ts',
      'src/A.tsx',
    ];
    const snapshot = [...input];
    const first = findSourcePathConflicts(input);
    const second = findSourcePathConflicts(input);
    expect(first).toEqual(second);
    expect(first.map((c) => c.key)).toEqual(['src/a', 'src/b']);
    expect(first[0].files).toEqual(['src/A.tsx', 'src/a.ts']);
    expect(first[1].files).toEqual(['src/B.ts', 'src/b.tsx']);
    expect(input).toEqual(snapshot);
  });

  it('非法输入抛 TypeError，不静默返回空', () => {
    expect(() => findSourcePathConflicts('not-an-array')).toThrow(TypeError);
    expect(() => findSourcePathConflicts([42])).toThrow(TypeError);
    expect(() => findSourcePathConflicts([''])).toThrow(TypeError);
  });
});

describe('scanSourcePaths（真实目录语义）', () => {
  it('递归收集 .ts/.tsx，跳过 symlink 与其它扩展名，输出 posix 排序', () => {
    const root = makeTempRoot('scan');
    writeSource(root, 'src/lib/format.ts');
    writeSource(root, 'src/lib/format.js'); // 非 ts/tsx，忽略
    writeSource(root, 'src/__tests__/App.test.tsx');

    // 链接目标放在 src 之外：里面的文件只能通过链接到达，错误跟随就会出现在结果里。
    const outside = join(root, 'outside-src');
    mkdirSync(outside, { recursive: true });
    writeSource(root, 'outside-src/hiddenByLink.ts');

    // Windows 普通进程无建 symlink 特权（EPERM）；有权限的环境补测 symlink 文件/目录排除，
    // 无权限时用 junction（目录联接，Windows 不需要特权）验证「联接不递归」。
    let linkTested = false;
    try {
      symlinkSync(join(outside, 'hiddenByLink.ts'), join(root, 'src/lib/link.ts'), 'file');
      symlinkSync(outside, join(root, 'src/link-dir'), 'dir');
      linkTested = true;
    } catch {
      symlinkSync(outside, join(root, 'src/junction-dir'), 'junction');
    }

    const files = scanSourcePaths(join(root, 'src'));
    expect(files).toEqual([
      '__tests__/App.test.tsx',
      'lib/format.ts',
    ]);
    // 保证链接确实建出来了（否则上面的排除断言是空的）。
    expect(linkTested || existsSync(join(root, 'src/junction-dir'))).toBe(true);
  });

  it('目录不存在抛 SourcePathScanError 而不是返回空列表', () => {
    const root = makeTempRoot('missing');
    const missing = join(root, 'no-such-dir');
    expect(() => scanSourcePaths(missing)).toThrow(SourcePathScanError);
    try {
      scanSourcePaths(missing);
    } catch (err) {
      expect(err.failures).toHaveLength(1);
      expect(err.failures[0].dir).toBe('.');
    }
  });

  it('rootDir 本身是 symlink/junction 时 fail closed：不跟随链接目标，也不假绿空列表', () => {
    const root = makeTempRoot('root-link');
    const realDir = join(root, 'real-src');
    writeSource(realDir, '__tests__/SavedTrips.test.tsx');
    writeSource(realDir, '__tests__/savedTrips.test.ts');
    let link = null;
    try {
      link = join(root, 'linked-src');
      symlinkSync(realDir, link, 'dir');
    } catch {
      link = join(root, 'linked-junction');
      symlinkSync(realDir, link, 'junction');
    }
    let caught = null;
    try {
      scanSourcePaths(link);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(SourcePathScanError);
    // fail closed：既不能扫出链接目标里的文件，也不能返回空列表装没看见。
    expect(caught.failures[0].code).toBe('SOURCE_ROOT_NOT_REAL_DIR');
  });

  it('rootDir 是文件时同样 fail closed', () => {
    const root = makeTempRoot('root-file');
    const file = join(root, 'a.ts');
    writeSource(root, 'a.ts');
    expect(() => scanSourcePaths(file)).toThrow(SourcePathScanError);
  });

  it('checkSourcePaths 一步完成扫描 + 冲突检测', () => {
    const root = makeTempRoot('check');
    writeSource(root, 'src/Foo.tsx');
    writeSource(root, 'src/foo.ts');
    const result = checkSourcePaths(root);
    expect(result.files).toEqual(['src/Foo.tsx', 'src/foo.ts']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe('src/foo');
  });
});

describe('runCli（进程内，fixture 在仓库外）', () => {
  it('无冲突报告文件数并返回 0', () => {
    const root = makeTempRoot('cli-ok');
    writeSource(root, 'src/a.ts');
    writeSource(root, 'src/__tests__/SavedTripsPanel.test.tsx');
    const lines = [];
    const code = runCli(['node', 'check-source-paths.mjs', '--source-root', root], {
      output: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('2 个 .ts/.tsx 文件');
    expect(lines.join('\n')).toContain('无');
  });

  it('有冲突列出组并返回非 0（1）', () => {
    const root = makeTempRoot('cli-conflict');
    writeSource(root, 'src/__tests__/TripBudgetTransfer.test.tsx');
    writeSource(root, 'src/__tests__/tripBudgetTransfer.test.ts');
    const lines = [];
    const code = runCli(['node', 'check-source-paths.mjs', '--source-root', root], {
      output: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('TripBudgetTransfer.test.tsx');
    expect(text).toContain('tripBudgetTransfer.test.ts');
    expect(text).toContain('重命名');
  });

  it('扫描失败返回非 0（2）且不假绿', () => {
    const root = makeTempRoot('cli-missing');
    const lines = [];
    const code = runCli(['node', 'check-source-paths.mjs', '--source-root', join(root, 'absent')], {
      output: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('失败');
  });

  it('非法参数返回非 0（2）', () => {
    const lines = [];
    const code = runCli(['node', 'check-source-paths.mjs', '--bogus'], {
      output: (l) => lines.push(l),
    });
    expect(code).toBe(2);
  });

  it('--source-root 空字符串被显式拒绝（exit 2），不静默回退默认根', () => {
    const lines = [];
    const code = runCli(['node', 'check-source-paths.mjs', '--source-root', ''], {
      output: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('--source-root 不能是空字符串');
  });

  it('parseCliArgs：未知参数/缺失参数值/空串都报 error；合法值通过', () => {
    expect(parseCliArgs(['node', 'x', '--bogus']).error).toBeTruthy();
    expect(parseCliArgs(['node', 'x', '--source-root']).error).toBeTruthy();
    expect(parseCliArgs(['node', 'x', '--source-root', '  ']).error).toBeTruthy();
    expect(parseCliArgs(['node', 'x', '--source-root', '/tmp/fake']).sourceRoot).toBe('/tmp/fake');
    expect(parseCliArgs(['node', 'x']).sourceRoot).toBeNull();
  });
});

describe('check-source-paths.mjs 真实子进程执行（不依赖 main 判断的进程内调用）', () => {
  const nodeBin = process.execPath;

  it('真实进程：正 fixture exit 0，输出含扫描数', () => {
    const root = makeTempRoot('subproc-ok');
    writeSource(root, 'src/ok.ts');
    writeSource(root, 'src/Panel.test.tsx');
    const stdout = execFileSync(nodeBin, [cliPath, '--source-root', root], {
      encoding: 'utf8',
      cwd: tmpdir(), // cwd 故意指向别处，证明结果与 cwd 无关
    });
    expect(stdout).toContain('无');
    expect(stdout).toContain('2 个 .ts/.tsx 文件');
  });

  it('真实进程：冲突 fixture exit 非 0，列出组', () => {
    const root = makeTempRoot('subproc-conflict');
    writeSource(root, 'src/__tests__/SavedTrips.test.tsx');
    writeSource(root, 'src/__tests__/savedTrips.test.ts');
    let failed = false;
    try {
      execFileSync(nodeBin, [cliPath, '--source-root', root], { encoding: 'utf8', cwd: tmpdir() });
    } catch (err) {
      failed = true;
      expect(err.status).toBe(1);
      expect(String(err.stdout)).toContain('savedtrips.test');
    }
    expect(failed).toBe(true);
  });

  it('真实进程：目录缺失 exit 非 0（2）', () => {
    const root = makeTempRoot('subproc-missing');
    let failed = false;
    try {
      execFileSync(nodeBin, [cliPath, '--source-root', join(root, 'nope')], { encoding: 'utf8' });
    } catch (err) {
      failed = true;
      expect(err.status).toBe(2);
    }
    expect(failed).toBe(true);
  });

  it('真实进程：--source-root 空字符串 exit 2，不静默回退默认根', () => {
    let failed = false;
    try {
      execFileSync(nodeBin, [cliPath, '--source-root', ''], { encoding: 'utf8', cwd: tmpdir() });
    } catch (err) {
      failed = true;
      expect(err.status).toBe(2);
      expect(String(err.stdout)).toContain('--source-root 不能是空字符串');
    }
    expect(failed).toBe(true);
  });

  it('真实进程：经 junction alias 路径调用 CLI 也必须执行检查（冲突 fixture exit 1）', () => {
    // 回归真实发现的问题：Node 会把 import.meta.url realpath 化，而 argv[1] 保留 alias 路径，
    // 旧版入口判断在 alias 调用时直接跳过检查静默 exit 0。现在入口无条件执行，此差异不再影响结果。
    const root = makeTempRoot('alias-conflict');
    const realDir = join(root, 'real');
    mkdirSync(realDir, { recursive: true });
    writeSource(realDir, 'src/__tests__/TripBudgetTransfer.test.tsx');
    writeSource(realDir, 'src/__tests__/tripBudgetTransfer.test.ts');
    // 把 CLI 两件套复制进 real dir，再建一个指向它的 junction，用 alias 路径调 CLI。
    writeFileSync(join(realDir, 'check-source-paths.mjs'), readFileSync(cliPath, 'utf8'), 'utf8');
    writeFileSync(
      join(realDir, 'sourcePathGuard.mjs'),
      readFileSync(resolve(here, 'sourcePathGuard.mjs'), 'utf8'),
      'utf8',
    );
    const alias = join(root, 'alias');
    try {
      symlinkSync(realDir, alias, 'dir');
    } catch {
      symlinkSync(realDir, alias, 'junction');
    }
    let failed = false;
    try {
      execFileSync(nodeBin, [join(alias, 'check-source-paths.mjs'), '--source-root', join(realDir, 'src')], {
        encoding: 'utf8',
        cwd: tmpdir(),
      });
    } catch (err) {
      failed = true;
      expect(err.status).toBe(1);
      expect(String(err.stdout)).toContain('tripbudgettransfer.test');
    }
    expect(failed).toBe(true);
  });

  it('真实进程：入口模块即使被 import 也会执行检查（不存在静默跳过路径）', () => {
    // 薄入口无条件执行：无论被 node 直接运行还是被别的脚本 import，
    // 都不会出现「入口判断不命中 → 跳过检查 → 静默 exit 0」的路径。
    const probe = makeTempRoot('entry-probe');
    const script = [
      `import ${JSON.stringify(pathToFileURL(cliPath).href)};`,
      'console.log("IMPORTED-AFTER-CHECK");',
    ].join('\n');
    const probeFile = join(probe, 'probe.mjs');
    writeFileSync(probeFile, script, 'utf8');
    const res = spawnSync(nodeBin, [probeFile], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('check-source-paths：OK');
    expect(res.stdout).toContain('IMPORTED-AFTER-CHECK');
  });

  it('真实进程：不带参数时按 import.meta.url 定位 frontend/src，且不受 cwd 影响', () => {
    const frontendDir = resolve(here); // frontend/
    const stdout = execFileSync(nodeBin, [cliPath], {
      encoding: 'utf8',
      cwd: tmpdir(), // 换 cwd 跑，输出必须与在 frontend/ 下跑一致
    });
    // 当前仓库 src 已无冲突：应当 OK。文件数会随仓库演进变化，这里只断言 OK 与确定性。
    expect(stdout).toContain('OK');
    // 同样命令在 frontend 目录下跑，结果一致（确定性、cwd 无关）。
    const stdout2 = execFileSync(nodeBin, [cliPath], { encoding: 'utf8', cwd: frontendDir });
    expect(stdout2).toBe(stdout);
  });

  it('CLI 依赖的真实模块可被 import（pathToFileURL 链路有效）', () => {
    expect(pathToFileURL(cliPath).href.startsWith('file://')).toBe(true);
  });

  it('默认根定位到 frontend/src 且与 cwd 无关', () => {
    const expected = resolve(here, 'src');
    expect(defaultSourceRoot()).toBe(expected);
  });
});
