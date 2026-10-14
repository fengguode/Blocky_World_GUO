'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function gitStatus(root) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(absolute)]);
      else if (stat.isDirectory()) {
        entries.push([relative, 'directory']);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        entries.push([relative, 'file', hash]);
      } else entries.push([relative, 'other']);
    }
  };
  visit(root);
  return entries;
}

function captureDeveloperState(root) {
  return {
    gitStatus: gitStatus(root),
    qaOutput: snapshotTree(path.join(root, '.qa-public')),
  };
}

function createCommittedCheckout(sourceRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(sourceRoot, '.qa-test-checkout-'));
  const root = path.join(temporaryRoot, 'repo');
  try {
    const commit = git(sourceRoot, ['rev-parse', 'HEAD']);
    const token = crypto.randomBytes(24).toString('hex');
    const objectDirectory = path.resolve(sourceRoot, git(sourceRoot, ['rev-parse', '--git-path', 'objects']));
    const gitDirectory = path.join(root, '.git');
    execFileSync('git', ['init', '--quiet', root], { cwd: sourceRoot, encoding: 'utf8' });
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.mkdirSync(path.join(gitDirectory, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, 'HEAD'), commit + '\n');
    fs.writeFileSync(path.join(gitDirectory, 'qa-test-checkout.marker'), token + '\n');
    fs.writeFileSync(path.join(gitDirectory, 'objects', 'info', 'alternates'), objectDirectory.replace(/\\/g, '/') + '\n');

    const records = execFileSync('git', ['ls-tree', '-rz', '--full-tree', commit], { cwd: sourceRoot });
    for (const recordBuffer of records.toString('utf8').split('\0').filter(Boolean)) {
      const tab = recordBuffer.indexOf('\t');
      const [mode, type] = recordBuffer.slice(0, tab).split(' ');
      const relative = recordBuffer.slice(tab + 1);
      if (type !== 'blob') continue;
      const destination = path.join(root, ...relative.split('/'));
      const contents = execFileSync('git', ['show', commit + ':' + relative], { cwd: sourceRoot, encoding: null });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (mode === '120000') fs.symlinkSync(contents.toString('utf8'), destination);
      else fs.writeFileSync(destination, contents);
    }
    execFileSync('git', ['read-tree', commit], { cwd: root, encoding: 'utf8' });
    const status = gitStatus(root);
    if (status) throw new Error('Disposable QA checkout at ' + root + ' is not clean (top ' + git(root, ['rev-parse', '--show-toplevel']) + ', gitdir ' + git(root, ['rev-parse', '--git-dir']) + '):\n' + status);
    return {
      root,
      token,
      dispose() { fs.rmSync(temporaryRoot, { recursive: true, force: true }); },
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function isDisposableCheckout(root, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return false;
  try {
    return fs.readFileSync(path.join(root, '.git', 'qa-test-checkout.marker'), 'utf8').trim() === token;
  } catch (_) {
    return false;
  }
}

function nodePathEnv(dependencyRoot, baseEnv = process.env) {
  const paths = [path.join(dependencyRoot, 'node_modules'), baseEnv.NODE_PATH]
    .filter((value) => value && fs.existsSync(value));
  return { ...baseEnv, NODE_PATH: [...new Set(paths)].join(path.delimiter) };
}

function spawnBuilder(root, dependencyRoot, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'build-qa.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: nodePathEnv(dependencyRoot, { ...process.env, ...extraEnv }),
  });
}

function exerciseDirtyBuildGuard(root, dependencyRoot) {
  const output = path.join(root, '.qa-public');
  if (fs.existsSync(output)) throw new Error('Expected a fresh disposable checkout without .qa-public');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'preserve-me.txt'), 'existing preview sentinel\n');

  const readme = path.join(root, 'README.md');
  const originalReadme = fs.readFileSync(readme);
  let result;
  let statusBefore;
  let statusAfter;
  let outputBefore;
  let outputAfter;
  try {
    fs.appendFileSync(readme, '\nQA dirty-checkout regression marker.\n');
    statusBefore = gitStatus(root);
    outputBefore = snapshotTree(output);
    result = spawnBuilder(root, dependencyRoot);
    statusAfter = gitStatus(root);
    outputAfter = snapshotTree(output);
  } finally {
    fs.writeFileSync(readme, originalReadme);
  }
  return {
    exitCode: result && result.status,
    diagnostic: result && (result.stderr || result.stdout || ''),
    statusBefore,
    statusAfter,
    outputBefore,
    outputAfter,
    statusCleanAfterRestore: gitStatus(root),
  };
}

module.exports = {
  captureDeveloperState,
  createCommittedCheckout,
  exerciseDirtyBuildGuard,
  gitStatus,
  isDisposableCheckout,
  nodePathEnv,
  snapshotTree,
  spawnBuilder,
};
