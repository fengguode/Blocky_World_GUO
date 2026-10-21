'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createPreviewServer,
  findLanAddress,
  isPrivateIPv4,
  verifyPreviewDirectory,
} = require('../scripts/serve-preview');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writePreview(root, assets) {
  for (const [file, content] of Object.entries(assets)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({
    mode: 'preview',
    source: { commit: 'a'.repeat(40) },
    assets: Object.fromEntries(Object.entries(assets).map(([file, content]) => [file, { sha256: sha256(content) }])),
  }));
}

function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  assert.equal(isPrivateIPv4('192.168.31.243'), true);
  assert.equal(isPrivateIPv4('10.0.0.5'), true);
  assert.equal(isPrivateIPv4('172.31.10.1'), true);
  assert.equal(isPrivateIPv4('172.32.10.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(findLanAddress({ eth0: [
    { family: 'IPv4', internal: true, address: '127.0.0.1' },
    { family: 'IPv4', internal: false, address: '10.1.0.8' },
    { family: 'IPv4', internal: false, address: '192.168.31.243' },
  ] }), '192.168.31.243');
  assert.equal(findLanAddress({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), null);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blocky-world-preview-server-'));
  const root = path.join(scratch, '.preview-public');
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"secret":"outside preview root"}');
    const assets = {
      'index.html': '<!doctype html><title>Blocky World Preview</title><script src="js/main.js"></script>',
      'style.css': 'body { color: white; }',
      'js/main.js': 'window.previewReady = true;',
    };
    writePreview(root, assets);
    const manifest = verifyPreviewDirectory(root);
    const server = createPreviewServer(root, manifest);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const base = 'http://127.0.0.1:' + server.address().port;
      const page = await request(base + '/');
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /^text\/html/);
      assert.match(page.body, /Blocky World Preview/);
      const script = await request(base + '/js/main.js');
      assert.equal(script.status, 200);
      assert.match(script.headers['content-type'], /^text\/javascript/);
      assert.equal(script.body, assets['js/main.js']);
      const head = await request(base + '/', 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      const traversal = await request(base + '/%2e%2e/package.json');
      assert.equal(traversal.status, 404);
      assert.doesNotMatch(traversal.body, /outside preview root/);
      const unlisted = await request(base + '/package.json');
      assert.equal(unlisted.status, 404);
      const post = await request(base + '/', 'POST');
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, 'GET, HEAD');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    fs.writeFileSync(path.join(root, 'js', 'main.js'), 'altered');
    assert.throws(() => verifyPreviewDirectory(root), /does not match provenance/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log('Playable preview server tests passed (private LAN selection, provenance, allowlist, traversal, method guards).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
