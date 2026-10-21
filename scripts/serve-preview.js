'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '.preview-public');
const PORT = 200;
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function verifyPreviewDirectory(root = ROOT) {
  const resolvedRoot = path.resolve(root);
  if (fs.lstatSync(resolvedRoot).isSymbolicLink() || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error('Playable preview root must be a real directory');
  }
  const manifestPath = path.join(resolvedRoot, 'provenance.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode !== 'preview' || !/^[0-9a-f]{40}$/.test(manifest.source && manifest.source.commit || '')) {
    throw new Error('Playable preview provenance is missing or has the wrong build mode');
  }
  if (!manifest.assets || typeof manifest.assets !== 'object' || !manifest.assets['index.html']) {
    throw new Error('Playable preview provenance has no asset inventory');
  }
  for (const [relative, record] of Object.entries(manifest.assets)) {
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Unsafe preview asset path in provenance: ' + relative);
    }
    const lexicalPath = path.resolve(resolvedRoot, relative);
    if (!isWithin(resolvedRoot, lexicalPath)) throw new Error('Preview asset escapes its root: ' + relative);
    const realPath = fs.realpathSync(lexicalPath);
    if (!isWithin(fs.realpathSync(resolvedRoot), realPath)) throw new Error('Preview asset resolves outside its root: ' + relative);
    if (!fs.statSync(realPath).isFile() || hashFile(realPath) !== record.sha256) {
      throw new Error('Preview asset does not match provenance: ' + relative);
    }
  }
  return manifest;
}

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function findLanAddress(networkInterfaces = os.networkInterfaces()) {
  const addresses = Object.values(networkInterfaces).flatMap((entries) => entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
    .map((entry) => entry.address);
  return addresses.find((address) => address.startsWith('192.168.')) || addresses[0] || null;
}

function createPreviewServer(root = ROOT, manifest = verifyPreviewDirectory(root)) {
  const resolvedRoot = path.resolve(root);
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const allowedFiles = new Set([...Object.keys(manifest.assets), 'provenance.json']);
  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Allow': 'GET, HEAD', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch (_) {
      response.writeHead(400, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (pathname.includes('\\') || pathname.includes('\0')) {
      response.writeHead(400, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!allowedFiles.has(relative)) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const lexicalPath = path.resolve(resolvedRoot, relative);
    if (!isWithin(resolvedRoot, lexicalPath)) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    let filePath, stat;
    try {
      filePath = fs.realpathSync(lexicalPath);
      if (!isWithin(canonicalRoot, filePath)) throw new Error('asset escaped preview root');
      stat = fs.statSync(filePath);
    } catch (_) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
    if (!stat.isFile() || !contentType) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  });
}

function start() {
  const manifest = verifyPreviewDirectory();
  const host = findLanAddress();
  if (!host) throw new Error('No private IPv4 LAN interface is available for the playable preview');
  const server = createPreviewServer(ROOT, manifest);
  server.on('error', (error) => {
    console.error('Preview server failed: ' + error.message);
    process.exitCode = 1;
  });
  server.listen(PORT, host, () => {
    console.log('Playable sanitized preview for commit ' + manifest.source.commit);
    console.log('LAN URL: http://' + host + ':' + PORT + '/');
    console.log('Static root: ' + ROOT);
    console.log('No profile, server, or persistent save files are served.');
  });
  return server;
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { CONTENT_TYPES, createPreviewServer, findLanAddress, hashFile, isPrivateIPv4, isWithin, verifyPreviewDirectory };
