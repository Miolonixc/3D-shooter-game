'use strict';
// Интеграционные тесты авторитарного мультиплеер-сервера: реальный сервер
// в процессе + сырой WS-клиент (тот же приём, что и в test/ws.test.js соседнего
// Snake-проекта). Покрывает протокол join/welcome/joined/left/state/snap,
// урон/смерть/респавн, счёт и чат — всё, что раньше проверялось только вручную
// через preview_eval + одноразовые bot-скрипты.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.PORT = '8999';
const { server, players } = require('../server/mp-server.cjs');

const PORT = 8999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(() => new Promise((resolve) => server.listen(PORT, resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

function frame(str) {
  const p = Buffer.from(str), len = p.length, mask = crypto.randomBytes(4);
  let h;
  if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
  else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
  const m = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) m[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([h, mask, m]);
}

function connect() {
  const net = require('net');
  const key = crypto.randomBytes(16).toString('base64');
  const hdr = ['GET /ws HTTP/1.1', `Host: 127.0.0.1:${PORT}`, 'Upgrade: websocket',
    'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
  const sock = net.connect(PORT, '127.0.0.1');
  const api = { sock, status: null, msgs: [] };
  let buf = Buffer.alloc(0), hs = false;
  sock.on('connect', () => sock.write(hdr.join('\r\n') + '\r\n\r\n'));
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!hs) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; api.status = buf.slice(0, i).toString().split('\r\n')[0]; hs = true; buf = buf.subarray(i + 4); if (!/101/.test(api.status)) return; }
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, p = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
      if (buf.length < p + len) break;
      const pl = buf.subarray(p, p + len).toString('utf8'); buf = buf.subarray(p + len);
      if (op === 0x1) api.msgs.push(pl);
    }
  });
  sock.on('error', () => {});
  api.send = (o) => sock.write(frame(JSON.stringify(o)));
  return api;
}
const parsed = (api) => api.msgs.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
const last = (api, t) => parsed(api).reverse().find((m) => m.t === t);

test('join -> welcome с собственным id; joined уходит остальным', async () => {
  const a = connect(); await sleep(100);
  a.send({ t: 'join', name: 'Alice' });
  await sleep(150);
  const b = connect(); await sleep(100);
  b.send({ t: 'join', name: 'Bob' });
  await sleep(150);
  try {
    const w = last(a, 'welcome');
    assert.ok(w && w.id, 'Alice получила welcome со своим id');
    const joined = last(a, 'joined');
    assert.ok(joined && joined.name === 'Bob', 'Alice узнала о присоединении Bob');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('кооп: первый игрок — хост; второй получает его id как host; хост уходит → миграция', async () => {
  const a = connect(); await sleep(100);
  a.send({ t: 'join', name: 'Host' });
  await sleep(150);
  const b = connect(); await sleep(100);
  b.send({ t: 'join', name: 'Guest' });
  await sleep(150);
  try {
    const wa = last(a, 'welcome'), wb = last(b, 'welcome');
    assert.ok(wa.host === wa.id, 'первый игрок — хост (host === свой id)');
    assert.equal(wb.host, wa.id, 'второй получил id первого как host');
    a.sock.destroy(); // хост уходит
    await sleep(200);
    const hostMsg = parsed(b).reverse().find((m) => m.t === 'host');
    assert.ok(hostMsg && hostMsg.id === wb.id, 'после ухода хоста гость назначен новым хостом');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('кооп: pve от хоста раздаётся гостям, от не-хоста — игнорируется; botshoot гостя идёт хосту', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Host' });
  b.send({ t: 'join', name: 'Guest' });
  await sleep(150);
  try {
    a.send({ t: 'pve', b: [[1, 0, 8, 1, 60, 0, 100, 1]], h: [], saved: 0, total: 2 });
    b.send({ t: 'pve', b: [[9, 0, 0, 0, 0, 0, 1, 1]], h: [], saved: 5, total: 5 }); // гость слать не должен — сервер отбросит
    await sleep(120);
    const pveAtGuest = parsed(b).filter((m) => m.t === 'pve');
    assert.ok(pveAtGuest.length >= 1, 'гость получил pve от хоста');
    assert.equal(pveAtGuest[pveAtGuest.length - 1].total, 2, 'это снапшот хоста, а не подделка гостя');
    const pveAtHost = parsed(a).filter((m) => m.t === 'pve');
    assert.equal(pveAtHost.length, 0, 'хосту не прилетает собственный pve, и pve от гостя не раздаётся');
    // botshoot от гостя должен прийти хосту
    b.send({ t: 'botshoot', target: 1, dmg: 50, head: false });
    await sleep(120);
    const bs = parsed(a).reverse().find((m) => m.t === 'botshoot');
    assert.ok(bs && bs.target === 1, 'хост получил botshoot гостя');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('кооп: botdmg от хоста ранит гостя (авторитарно), от не-хоста игнорируется', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Host' });
  b.send({ t: 'join', name: 'Guest' });
  await sleep(150);
  const guestId = last(b, 'welcome').id;
  try {
    a.send({ t: 'botdmg', target: guestId, dmg: 40 }); // хост: бот ранил гостя
    await sleep(120);
    const dmg = parsed(b).reverse().find((m) => m.t === 'dmg');
    assert.ok(dmg && dmg.hp === 60, 'гость получил урон от бота (hp 100-40=60), by=null (бот)');
    assert.equal(dmg.by, null, 'источник урона — бот (by null)');
    b.send({ t: 'botdmg', target: guestId, dmg: 40 }); // не-хост шлёт botdmg — сервер должен игнорировать
    await sleep(120);
    const dmgs = parsed(b).filter((m) => m.t === 'dmg');
    assert.equal(dmgs.length, 1, 'botdmg от не-хоста проигнорирован');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('state доходит до снапшота при 2+ игроках', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'A' });
  b.send({ t: 'join', name: 'B' });
  await sleep(100);
  a.send({ t: 'state', x: 5, y: 0, z: 7, yaw: 1.2, c: false });
  await sleep(150); // SNAP_HZ=20 -> снапшот раз в 50мс, должно успеть
  try {
    const snap = last(b, 'snap');
    assert.ok(snap, 'снапшот пришёл');
    const wA = last(a, 'welcome');
    const row = snap.p.find((r) => r[0] === wA.id);
    assert.ok(row, 'позиция Alice есть в снапшоте');
    assert.equal(row[1], 5); assert.equal(row[3], 7);
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('body-выстрел: сервер сам считает урон по оружию, не доверяя числу от клиента', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Shooter' });
  b.send({ t: 'join', name: 'Target' });
  await sleep(100);
  const targetId = last(b, 'welcome').id;
  a.send({ t: 'shoot', target: targetId, weapon: 'Пистолет', head: false, dmg: 99999 }); // подделанный урон должен игнорироваться
  await sleep(100);
  try {
    const dmg = last(b, 'dmg') || last(a, 'dmg');
    assert.ok(dmg, 'dmg-сообщение разослано');
    assert.equal(dmg.hp, 50, 'body-урон пистолета = 50, число от клиента проигнорировано');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('rate limit урона: выстрелы чаще самого быстрого ствола не засчитываются', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Spammer' });
  b.send({ t: 'join', name: 'Victim' });
  await sleep(100);
  const targetId = last(b, 'welcome').id;
  // залп из 5 body-выстрелов пистолета подряд (5×50=250 урона хватило бы на 2 смерти),
  // но SHOOT_MIN_INTERVAL_MS≈55 — засчитаться должен максимум один
  for (let i = 0; i < 5; i++) a.send({ t: 'shoot', target: targetId, weapon: 'Пистолет', head: false });
  await sleep(150);
  try {
    const dmgs = parsed(b).filter((m) => m.t === 'dmg');
    const kills = parsed(a).filter((m) => m.t === 'kill');
    assert.ok(dmgs.length + kills.length <= 1, 'из залпа засчитан максимум один выстрел, а не все пять');
    if (dmgs.length) assert.equal(dmgs[0].hp, 50, 'один пистолетный body-выстрел = 50 урона');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('headshot добивает и запускает респавн', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Shooter2' });
  b.send({ t: 'join', name: 'Target2' });
  await sleep(100);
  const targetId = last(b, 'welcome').id;
  a.send({ t: 'shoot', target: targetId, weapon: 'Пистолет', head: true });
  await sleep(100);
  try {
    const kill = last(a, 'kill');
    assert.ok(kill && kill.id === targetId, 'kill-сообщение с верной жертвой');
    await sleep(3100); // RESPAWN_MS=3000
    const respawn = parsed(a).reverse().find((m) => m.t === 'respawn' && m.id === targetId);
    assert.ok(respawn, 'respawn пришёл через ~3с после смерти');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('мёртвого нельзя добить повторно (сервер игнорирует выстрел по !alive)', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'S3' });
  b.send({ t: 'join', name: 'T3' });
  await sleep(100);
  const targetId = last(b, 'welcome').id;
  a.send({ t: 'shoot', target: targetId, weapon: 'Пистолет', head: true }); // убивает
  await sleep(100);
  const killsBefore = parsed(a).filter((m) => m.t === 'kill').length;
  a.send({ t: 'shoot', target: targetId, weapon: 'Пистолет', head: true }); // по трупу
  await sleep(100);
  try {
    const killsAfter = parsed(a).filter((m) => m.t === 'kill').length;
    assert.equal(killsAfter, killsBefore, 'второй выстрел по мёртвому не дал ещё один kill');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('score рассылается всем при kill', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'S4' });
  b.send({ t: 'join', name: 'T4' });
  await sleep(100);
  const targetId = last(b, 'welcome').id;
  const shooterId = last(a, 'welcome').id;
  a.send({ t: 'shoot', target: targetId, weapon: 'Пистолет', head: true });
  await sleep(100);
  try {
    const score = last(a, 'score');
    assert.ok(score, 'score пришёл');
    const row = score.list.find((r) => r[0] === shooterId);
    assert.ok(row && row[2] === 1, 'у убийцы kills=1 в таблице результатов');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('чат: сообщение доходит с именем отправителя', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Chatty' });
  b.send({ t: 'join', name: 'Listener' });
  await sleep(100);
  a.send({ t: 'chat', text: 'привет!' });
  await sleep(100);
  try {
    const chat = last(b, 'chat');
    assert.ok(chat && chat.name === 'Chatty' && chat.text === 'привет!');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('чат: управляющие символы вырезаются, пустое сообщение не рассылается', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Chatty2' });
  b.send({ t: 'join', name: 'Listener2' });
  await sleep(100);
  a.send({ t: 'chat', text: '  \n\t  ' }); // после clean() станет пустым
  await sleep(100);
  try {
    const chat = last(b, 'chat');
    assert.ok(!chat, 'пустое после очистки сообщение не разослано');
  } finally { a.sock.destroy(); b.sock.destroy(); }
});

test('left уходит остальным при отключении', async () => {
  const a = connect(), b = connect();
  await sleep(100);
  a.send({ t: 'join', name: 'Leaver' });
  b.send({ t: 'join', name: 'Stayer' });
  await sleep(100);
  const leaverId = last(a, 'welcome').id;
  a.sock.destroy();
  await sleep(150);
  try {
    const left = last(b, 'left');
    assert.ok(left && left.id === leaverId);
    assert.ok(!players.has(leaverId), 'игрок удалён из players после disconnect');
  } finally { b.sock.destroy(); }
});
