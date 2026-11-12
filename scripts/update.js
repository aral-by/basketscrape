#!/usr/bin/env node
/*
 * Installs or updates BasketScrape from GitHub — no git, no zip tool, only Node.
 *
 *   node scripts/update.js [--dir <install dir>] [--force] [--quiet]
 *
 * 1. Asks GitHub for the newest commit on the branch (default: main).
 * 2. If it differs from <dir>/.version, downloads the branch tarball, unpacks it in memory and
 *    writes the files into <dir>. data/ (recordings, open matches) and node_modules/ are never
 *    touched; files removed upstream are removed locally (tracked in .installed-files.json).
 * 3. Runs `npm install` when package.json / package-lock.json changed.
 *
 * Offline or GitHub down → prints a note and exits 0, so the app still starts.
 * Environment: BASKETSCRAPE_REPO (owner/name), BASKETSCRAPE_BRANCH.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = process.env.BASKETSCRAPE_REPO || 'aral-by/basketscrape';
const BRANCH = process.env.BASKETSCRAPE_BRANCH || 'main';
const KEEP = ['data', 'node_modules', '.version', '.installed-files.json'];
const HEADERS = { 'User-Agent': 'basketscrape-updater', Accept: 'application/vnd.github+json' };

function parseArgs(argv) {
  const a = { dir: path.resolve(__dirname, '..'), force: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--force') a.force = true;
    else if (argv[i] === '--quiet') a.quiet = true;
  }
  return a;
}

// ── tar (ustar + pax/GNU long names), enough for GitHub tarballs ─────────────
function parseTar(buf) {
  const files = [];
  let off = 0;
  let longName = null;
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    let name = str(h.subarray(0, 100));
    if (prefix) name = prefix + '/' + name;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {                       // pax header for the next entry
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'L') { longName = str(body); continue; }   // GNU long name
    if (type === 'g') continue;               // global pax header (commit id)
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0' || type === '7') files.push({ name, data: Buffer.from(body) });
  }
  return files;
}

/** GitHub tarballs wrap everything in "<repo>-<sha>/"; strip it and reject unsafe paths. */
function stripRoot(files) {
  const out = [];
  for (const f of files) {
    const rel = f.name.split('/').slice(1).join('/');
    if (!rel || rel.endsWith('/')) continue;
    const norm = path.posix.normalize(rel);
    if (norm.startsWith('..') || path.posix.isAbsolute(norm)) continue;
    out.push({ name: norm, data: f.data });
  }
  return out;
}

function isKept(rel) {
  const top = rel.split('/')[0];
  return KEEP.includes(top);
}

function hashOf(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** Writes `files` into `dir`; removes files from the previous install that are gone upstream. */
function applyFiles(dir, files) {
  const manifestPath = path.join(dir, '.installed-files.json');
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first install */ }
  const depsBefore = ['package.json', 'package-lock.json'].map((f) => hashOf(path.join(dir, f))).join();

  const names = [];
  for (const f of files) {
    if (isKept(f.name)) continue;
    const target = path.join(dir, ...f.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.new';
    fs.writeFileSync(tmp, f.data);
    fs.renameSync(tmp, target);
    names.push(f.name);
  }
  const now = new Set(names);
  for (const old of previous) {
    if (!now.has(old) && !isKept(old)) fs.rmSync(path.join(dir, ...old.split('/')), { force: true });
  }
  fs.writeFileSync(manifestPath, JSON.stringify(names));
  const depsAfter = ['package.json', 'package-lock.json'].map((f) => hashOf(path.join(dir, f))).join();
  return { written: names.length, depsChanged: depsBefore !== depsAfter };
}

async function latestSha() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return (await r.json()).sha;
}

async function download(sha) {
  const r = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!r.ok) throw new Error(`indirme ${r.status}`);
  return zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
}

function npmInstall(dir, log) {
  log('Gerekli paketler kuruluyor (ilk kurulumda birkaç dakika sürebilir)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) throw new Error('npm install başarısız oldu');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => { if (!args.quiet) console.log(m); };
  fs.mkdirSync(args.dir, { recursive: true });
  const versionFile = path.join(args.dir, '.version');
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;

  let sha;
  try {
    sha = await latestSha();
  } catch (e) {
    log(`Güncelleme kontrol edilemedi (${e.message}); mevcut sürümle devam ediliyor.`);
    return current ? 0 : 1;
  }
  const needDeps = !fs.existsSync(path.join(args.dir, 'node_modules'));
  if (sha === current && !args.force) {
    log('BasketScrape güncel.');
    if (needDeps) npmInstall(args.dir, log);
    return 0;
  }

  log(current ? 'Yeni sürüm bulundu, güncelleniyor…' : 'BasketScrape indiriliyor…');
  const files = stripRoot(parseTar(await download(sha)));
  if (!files.some((f) => f.name === 'src/server.js')) throw new Error('indirilen paket eksik');
  const { written, depsChanged } = applyFiles(args.dir, files);
  log(`${written} dosya yazıldı.`);
  if (depsChanged || needDeps) npmInstall(args.dir, log);
  fs.writeFileSync(versionFile, sha + '\n');
  log(`Sürüm: ${sha.slice(0, 7)}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    console.error('Güncelleme hatası: ' + e.message);
    process.exit(fs.existsSync(path.join(parseArgs(process.argv.slice(2)).dir, 'src', 'server.js')) ? 0 : 1);
  });
}

module.exports = { parseTar, stripRoot, applyFiles, isKept };
