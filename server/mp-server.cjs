'use strict';
// Авторитарный сервер мультиплеера 3D-шутера (этап 1: синхронизация позиций).
// Zero-dep: HTTP + собственный WebSocket-кодек (server/ws.js, тот же что в Snake).
// Запуск: node server/mp-server.js  (порт через PORT, по умолчанию 8090)
// Интернет-игра: хост пробрасывает порт или поднимает туннель (cloudflared/ngrok),
// клиенты подключаются как ?server=wss://адрес-туннеля (см. netConnect в клиенте).

const http = require('http');
const crypto = require('crypto');
const ws = require('./ws.cjs');

const PORT = Number(process.env.PORT || 8090);
const MAX_PLAYERS = 8;          // 4+ по требованию, с запасом
const SNAP_HZ = 20;             // частота рассылки снапшотов
const MAX_MSG_PER_SEC = 60;     // анти-флуд на соединение
const NAME_MAX = 16;

/** @type {Map<string, {conn: any, name: string, x:number,y:number,z:number,yaw:number,crouch:boolean}>} */
const players = new Map();

function sendTo(conn, obj) { conn.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const [id, p] of players) if (id !== exceptId) p.conn.send(s);
}

const server = http.createServer((req, res) => {
  // health-check/заглушка для туннелей
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('shooter mp server, players: ' + players.size + '/' + MAX_PLAYERS + '\n');
});

ws.attach(server, '/ws', (conn) => {
  let id = null;
  let msgCount = 0;
  let msgWindow = Date.now();

  conn.onMessage = (raw) => {
    // анти-флуд: окно в 1 секунду
    const now = Date.now();
    if (now - msgWindow > 1000) { msgWindow = now; msgCount = 0; }
    if (++msgCount > MAX_MSG_PER_SEC) { conn.close(); return; }

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !id) {
      if (players.size >= MAX_PLAYERS) { sendTo(conn, { t: 'full' }); conn.close(); return; }
      id = crypto.randomBytes(4).toString('hex');
      const name = String(m.name || 'player').slice(0, NAME_MAX);
      players.set(id, { conn, name, x: 0, y: 0, z: 0, yaw: 0, crouch: false });
      // новичку — его id и список остальных; остальным — уведомление
      sendTo(conn, {
        t: 'welcome', id,
        players: [...players.entries()].filter(([pid]) => pid !== id)
          .map(([pid, p]) => ({ id: pid, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw })),
      });
      broadcast({ t: 'joined', id, name }, id);
      console.log(`+ ${name} (${id}) — игроков: ${players.size}`);
      return;
    }

    if (m.t === 'state' && id) {
      const p = players.get(id);
      if (!p) return;
      // валидация типов; авторитарность по урону будет на этапе 2, позицию пока доверяем
      if (Number.isFinite(m.x)) p.x = m.x;
      if (Number.isFinite(m.y)) p.y = m.y;
      if (Number.isFinite(m.z)) p.z = m.z;
      if (Number.isFinite(m.yaw)) p.yaw = m.yaw;
      p.crouch = !!m.c;
    }
  };

  conn.onClose = () => {
    if (id && players.has(id)) {
      const name = players.get(id).name;
      players.delete(id);
      broadcast({ t: 'left', id });
      console.log(`- ${name} (${id}) — игроков: ${players.size}`);
    }
  };
});

// снапшоты: компактный массив массивов, только когда есть кому слать
setInterval(() => {
  if (players.size < 2) return;
  const snap = { t: 'snap', p: [...players.entries()].map(([pid, p]) => [pid, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3), p.crouch ? 1 : 0]) };
  broadcast(snap);
}, 1000 / SNAP_HZ);

server.listen(PORT, () => console.log(`shooter mp server: ws://0.0.0.0:${PORT}/ws (макс. ${MAX_PLAYERS} игроков)`));
