'use strict';
/* ============================================================
   tests/run.js — process-isolated test runner

   Why this exists: JavaScript is single threaded, so a test stuck in a
   synchronous infinite loop cannot be interrupted from inside its own
   process. A cooperative "check the clock" watchdog does not help — the
   loop never yields to check. The only reliable bound is a child process
   that can be killed.

   So each suite runs in its own child. If it exceeds TEST_TIMEOUT_MS it
   is killed and reported as HANG along with the last test that started,
   which pinpoints the culprit immediately instead of freezing the run.

   Usage:
     node tests/run.js                  run everything
     node tests/run.js Meshing Physics  run matching suites only
     node tests/run.js --list           list suite names
     node tests/run.js --verbose        also show child stderr
   ============================================================ */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const LOGIC = path.join(__dirname, 'logic.test.js');
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120000);

const args = process.argv.slice(2);
const verbose = args.indexOf('--verbose') !== -1;

// Ask the test file which suites exist. It loads the game sandbox, which is
// slow, so we only do it once here and reuse the list for the children.
function listSuites() {
  const r = spawnSync(process.execPath, [LOGIC, '--print-suites'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error('Could not enumerate suites. The test file failed to load:');
    console.error(r.stderr || '(no stderr)');
    process.exit(2);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    console.error('Unexpected suite listing:\n' + r.stdout.slice(0, 500));
    process.exit(2);
  }
}

if (args.indexOf('--list') !== -1) {
  listSuites().forEach((s) => {
    console.log(s.name + '  (' + s.tests.length + ' tests)');
  });
  process.exit(0);
}

const all = listSuites();
const filters = args.filter((a) => a[0] !== '-');
const targets = filters.length
  ? all.filter((s) => filters.some((f) => s.name.toLowerCase().includes(f.toLowerCase())))
  : all;

if (!targets.length) {
  console.log('No suites matched' + (filters.length ? ': ' + filters.join(', ') : ''));
  console.log('Available: ' + all.map((s) => s.name).join(', '));
  process.exit(1);
}

console.log('Running ' + targets.length + ' suite' + (targets.length === 1 ? '' : 's') +
  ' in isolated processes (timeout ' + (TIMEOUT_MS / 1000) + 's each)');

let totalPass = 0;
let totalFail = 0;
let totalHang = 0;
const problems = [];

// The last PASS/FAIL line printed by a child identifies which test was in
// flight when it died.
function lastTestStarted(text) {
  const lines = text.split('\n').filter((l) => /^\s+(PASS|FAIL)\s/.test(l));
  if (!lines.length) return null;
  return lines[lines.length - 1].trim().replace(/^(PASS|FAIL)\s+/, '');
}

function runSuite(suite, index) {
  return new Promise((resolve) => {
    const label = '[' + (index + 1) + '/' + targets.length + '] ' + suite.name;
    process.stdout.write('\n' + label + '\n');

    const child = spawn(process.execPath, [LOGIC, '--suite', suite.name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { TEST_TIMEOUT_MS: String(TIMEOUT_MS) }),
    });

    let out = '';
    let hung = false;

    const killer = setTimeout(() => {
      hung = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already exited */ }
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
      if (verbose) process.stderr.write(d);
    });

    child.on('error', (e) => {
      clearTimeout(killer);
      problems.push({ kind: 'ERROR', suite: suite.name, test: String(e.message) });
      process.stdout.write('  ERROR  could not start: ' + e.message + '\n');
      resolve();
    });

    child.on('close', (code, signal) => {
      clearTimeout(killer);

      if (hung || signal === 'SIGKILL') {
        totalHang++;
        const culprit = lastTestStarted(out);
        problems.push({
          kind: 'HANG',
          suite: suite.name,
          test: culprit || '(nothing reported — likely during setup)',
        });
        process.stdout.write('  HANG   suite exceeded ' + (TIMEOUT_MS / 1000) + 's and was killed' +
          (culprit ? '\n         last test that started: ' + culprit : '') + '\n');
        return resolve();
      }

      const m = /(\d+) passed, (\d+) failed/.exec(out);
      if (m) {
        totalPass += Number(m[1]);
        totalFail += Number(m[2]);
      } else if (code !== 0) {
        // The child died before printing a summary.
        totalFail++;
        problems.push({
          kind: 'CRASH',
          suite: suite.name,
          test: lastTestStarted(out) || '(during setup)',
        });
        process.stdout.write('  CRASH  exited with code ' + code + ' before finishing\n');
        if (!verbose && out) {
          process.stdout.write('         ' + out.trim().split('\n').pop() + '\n');
        }
      }
      resolve();
    });
  });
}

(async () => {
  for (let i = 0; i < targets.length; i++) {
    await runSuite(targets[i], i);
  }

  console.log('\n' + '='.repeat(58));
  console.log('  ' + totalPass + ' passed, ' + totalFail + ' failed' +
    (totalHang ? ', ' + totalHang + ' hung' : ''));
  console.log('='.repeat(58));

  if (problems.length) {
    console.log('\nNeeds attention:');
    for (const p of problems) {
      console.log('  [' + p.kind + '] ' + p.suite + ' — ' + p.test);
    }
    console.log('\nRe-run just that suite with:  node tests/run.js "' + problems[0].suite + '"');
  }

  process.exit(totalFail || totalHang ? 1 : 0);
})();