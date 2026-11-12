// scripts/update.js: tarball parsing and file application (no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTar, stripRoot, applyFiles } = require('../scripts/update');

function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  return h;
}
function entry(name, content, type = '0') {
  const data = Buffer.from(content);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return [header(name, data.length, type), data, pad];
}
function tarball(entries) {
  return Buffer.concat([...entries.flat(), Buffer.alloc(1024)]);
}

test('parses GitHub-style tarballs, including pax long names, and strips the root folder', () => {
  const long = 'repo-abc/' + 'deep/'.repeat(25) + 'file.txt';
  const pax = `${long.length + 7 + 3} path=${long}\n`;
  const buf = tarball([
    entry('pax_global_header', '52 comment=abc\n', 'g'),
    entry('repo-abc/', '', '5'),
    entry('repo-abc/src/server.js', 'console.log(1)'),
    entry('repo-abc/PaxHeaders/x', pax, 'x'),
    entry('ignored-short-name', 'LONG'),
    entry('repo-abc/../evil.js', 'nope'),
  ]);
  const files = stripRoot(parseTar(buf));
  assert.deepEqual(files.map((f) => f.name), ['src/server.js', 'deep/'.repeat(25) + 'file.txt']);
  assert.equal(files[1].data.toString(), 'LONG');
});

test('applying an update keeps user data and removes files deleted upstream', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-up-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'sessions.json'), 'mine');

  let r = applyFiles(dir, [
    { name: 'src/a.js', data: Buffer.from('a1') },
    { name: 'src/old.js', data: Buffer.from('old') },
    { name: 'package.json', data: Buffer.from('{"v":1}') },
    { name: 'data/sessions.json', data: Buffer.from('upstream must not win') },
  ]);
  assert.equal(r.written, 3);
  assert.equal(r.depsChanged, true);

  r = applyFiles(dir, [
    { name: 'src/a.js', data: Buffer.from('a2') },
    { name: 'package.json', data: Buffer.from('{"v":1}') },
  ]);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'a2');
  assert.equal(fs.existsSync(path.join(dir, 'src', 'old.js')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'sessions.json'), 'utf8'), 'mine');
  assert.equal(r.depsChanged, false, 'same package.json → no npm install');
});
