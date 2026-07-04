'use strict';
// Юнит-тесты WebSocket-хелперов (Origin, кодирование кадров).
const test = require('node:test');
const assert = require('node:assert/strict');
const { originAllowed, hostOf, encodeFrame } = require('../server/ws.cjs');

const req = (origin, host) => ({ headers: { origin, host } });

test('hostOf вырезает схему, порт и путь', () => {
  assert.equal(hostOf('http://1.2.3.4:8080/x'), '1.2.3.4');
  assert.equal(hostOf('https://example.com'), 'example.com');
  assert.equal(hostOf(''), '');
});

test('originAllowed: нет Origin -> разрешено', () => {
  assert.equal(originAllowed(req(undefined, '1.2.3.4:8080')), true);
});

test('originAllowed: same-host и localhost -> разрешено', () => {
  assert.equal(originAllowed(req('http://1.2.3.4:8080', '1.2.3.4:8080')), true);
  assert.equal(originAllowed(req('http://localhost:3000', '1.2.3.4:8080')), true);
});

test('originAllowed: чужой Origin -> запрещено', () => {
  assert.equal(originAllowed(req('http://evil.example.com', '1.2.3.4:8080')), false);
});

test('originAllowed: SHOOTER_ALLOW_ORIGINS содержит хост -> разрешено', () => {
  process.env.SHOOTER_ALLOW_ORIGINS = 'miolonixc.github.io';
  assert.equal(originAllowed(req('https://miolonixc.github.io', '139-28-223-251.sslip.io')), true);
  delete process.env.SHOOTER_ALLOW_ORIGINS;
});

test('originAllowed: SHOOTER_ALLOW_ORIGINS=* -> разрешено всё', () => {
  process.env.SHOOTER_ALLOW_ORIGINS = '*';
  assert.equal(originAllowed(req('http://evil.example.com', 'x')), true);
  delete process.env.SHOOTER_ALLOW_ORIGINS;
});

test('encodeFrame: малый текстовый кадр = 0x81 + длина', () => {
  const f = encodeFrame('hi'); // len 2
  assert.equal(f[0], 0x81);
  assert.equal(f[1], 2);
  assert.equal(f.subarray(2).toString(), 'hi');
});

test('encodeFrame: длина 126..65535 -> 16-битный заголовок', () => {
  const f = encodeFrame('x'.repeat(200));
  assert.equal(f[0], 0x81);
  assert.equal(f[1], 126);
  assert.equal(f.readUInt16BE(2), 200);
});
