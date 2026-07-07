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
const CHAT_MAX = 140;
const CHAT_MIN_INTERVAL_MS = 400; // анти-спам чата отдельно от общего флуд-лимита
const RESPAWN_MS = 3000;
const MAX_HP = 100;
// урон и темп по оружию считает сервер (не доверяем числам от клиента) — те же цифры, что в src/main.ts (Weapon)
const WEAPON = {
  'Пистолет': { body: 50, head: 100, interval: 170 },
  'SMG': { body: 24, head: 55, interval: 75 },
};
// минимальный интервал между засчитанными выстрелами: берём самый быстрый ствол минус
// допуск на сетевой джиттер/буферизацию (клиент мог выстрелить чётко в темп, но пакеты
// пришли пачкой). Выстрелы чаще — модифицированный клиент, игнорируем (rate limit урона).
const SHOOT_MIN_INTERVAL_MS = 55;

/** @type {Map<string, {conn: any, name: string, x:number,y:number,z:number,yaw:number,crouch:boolean,hp:number,alive:boolean,kills:number,deaths:number}>} */
const players = new Map();
// кооп-режим заложников: один игрок — «хост» PvE (крутит ИИ ботов локально и вещает мир
// снапшотами 't:pve'), остальные — гости (рендерят). Первый подключившийся становится хостом;
// при его уходе хостом становится следующий по порядку. См. host-authoritative в клиенте.
let pveHostId = null;
function pickHost() { pveHostId = players.size ? players.keys().next().value : null; }

function sendTo(conn, obj) { conn.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const [id, p] of players) if (id !== exceptId) p.conn.send(s);
}
function scoreList() {
  return [...players.entries()].map(([id, p]) => [id, p.name, p.kills, p.deaths]);
}
function broadcastScore() { broadcast({ t: 'score', list: scoreList() }); }
// применить урон к игроку (общее для PvP-shoot и bot-damage в коопе); byId — кто нанёс (или null=бот)
function applyDamage(targetId, target, dmg, byId, shooter) {
  target.hp = Math.max(0, target.hp - dmg);
  if (target.hp <= 0) {
    target.alive = false;
    target.deaths++;
    if (shooter) shooter.kills++;
    broadcast({ t: 'kill', id: targetId, by: byId || null });
    broadcastScore();
    console.log(`x ${shooter ? shooter.name : 'бот'} убил ${target.name}`);
    setTimeout(() => {
      const p = players.get(targetId);
      if (!p) return;
      p.hp = MAX_HP; p.alive = true;
      broadcast({ t: 'respawn', id: targetId });
    }, RESPAWN_MS);
  } else {
    broadcast({ t: 'dmg', id: targetId, hp: target.hp, by: byId || null });
  }
}
// вырезаем управляющие символы (перевод строки и т.п. ломает и консольные логи, и однострочный UI чата)
function clean(s, max) { return String(s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max); }

const server = http.createServer((req, res) => {
  // health-check/заглушка для туннелей
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('shooter mp server, players: ' + players.size + '/' + MAX_PLAYERS + '\n');
});

ws.attach(server, '/ws', (conn) => {
  let id = null;
  let msgCount = 0;
  let msgWindow = Date.now();
  let lastChatAt = 0;

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
      const name = clean(m.name, NAME_MAX) || 'player';
      players.set(id, { conn, name, x: 0, y: 0, z: 0, yaw: 0, crouch: false, hp: MAX_HP, alive: true, kills: 0, deaths: 0, lastShotAt: 0 });
      if (!pveHostId) pickHost(); // первый игрок — хост PvE
      // новичку — его id, список остальных и текущий хост; остальным — уведомление
      sendTo(conn, {
        t: 'welcome', id, host: pveHostId,
        players: [...players.entries()].filter(([pid]) => pid !== id)
          .map(([pid, p]) => ({ id: pid, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, alive: p.alive })),
      });
      broadcast({ t: 'joined', id, name }, id);
      broadcastScore();
      console.log(`+ ${name} (${id}) — игроков: ${players.size}, хост: ${pveHostId}`);
      return;
    }

    // кооп: хост вещает мир (боты+заложники) — просто раздаём остальным. Только от хоста.
    if (m.t === 'pve' && id === pveHostId) { broadcast(m, id); return; }
    // кооп: гость выстрелил в бота / хочет забрать заложника — маршрутизируем хосту.
    // (хосту добавляем who=id гостя, чтобы он знал, за кем должен идти заложник)
    if ((m.t === 'botshoot' || m.t === 'takehostage') && id && id !== pveHostId) {
      const h = players.get(pveHostId); if (h) sendTo(h.conn, { ...m, who: id }); return;
    }
    // кооп: бот хоста ранил гостя — только хост, применяем к hp цели авторитарно
    if (m.t === 'botdmg' && id === pveHostId) {
      const target = typeof m.target === 'string' ? players.get(m.target) : null;
      if (target && target.alive && Number.isFinite(m.dmg)) applyDamage(m.target, target, Math.min(100, m.dmg), null, null);
      return;
    }

    if (m.t === 'state' && id) {
      const p = players.get(id);
      if (!p) return;
      // валидация типов; позицию доверяем клиенту, урон/смерть/респавн — сервер (ниже)
      if (Number.isFinite(m.x)) p.x = m.x;
      if (Number.isFinite(m.y)) p.y = m.y;
      if (Number.isFinite(m.z)) p.z = m.z;
      if (Number.isFinite(m.yaw)) p.yaw = m.yaw;
      p.crouch = !!m.c;
      return;
    }

    if (m.t === 'shoot' && id) {
      const shooter = players.get(id);
      const target = typeof m.target === 'string' ? players.get(m.target) : null;
      if (!shooter || !target || !shooter.alive || !target.alive || m.target === id) return;
      // rate limit урона: выстрелы чаще самого быстрого ствола = чит-клиент, отбрасываем
      const nowShot = Date.now();
      if (nowShot - shooter.lastShotAt < SHOOT_MIN_INTERVAL_MS) return;
      shooter.lastShotAt = nowShot;
      const table = WEAPON[m.weapon] || WEAPON['Пистолет'];
      applyDamage(m.target, target, m.head ? table.head : table.body, id, shooter);
      return;
    }

    if (m.t === 'chat' && id) {
      const now2 = Date.now();
      if (now2 - lastChatAt < CHAT_MIN_INTERVAL_MS) return;
      const p = players.get(id);
      if (!p) return;
      const text = clean(m.text, CHAT_MAX);
      if (!text) return;
      lastChatAt = now2;
      broadcast({ t: 'chat', id, name: p.name, text });
      console.log(`  💬 ${p.name}: ${text}`);
    }
  };

  conn.onClose = () => {
    if (id && players.has(id)) {
      const name = players.get(id).name;
      const wasHost = id === pveHostId;
      players.delete(id);
      broadcast({ t: 'left', id });
      broadcastScore();
      if (wasHost) { pickHost(); broadcast({ t: 'host', id: pveHostId }); console.log(`  хост ушёл → новый хост: ${pveHostId}`); }
      console.log(`- ${name} (${id}) — игроков: ${players.size}`);
    }
  };
});

// снапшоты: компактный массив массивов, только когда есть кому слать
const snapTimer = setInterval(() => {
  if (players.size < 2) return;
  const snap = { t: 'snap', p: [...players.entries()].map(([pid, p]) => [pid, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3), p.crouch ? 1 : 0]) };
  broadcast(snap);
}, 1000 / SNAP_HZ);
snapTimer.unref(); // не держать процесс живым только ради этого таймера (важно для тестов, где сервер стартует/стопается)

// require.main-гвард — чтобы тесты могли require() этот файл (за players/scoreList
// и т.п.) не поднимая настоящий листенер на боевом PORT.
if (require.main === module) {
  server.listen(PORT, () => console.log(`shooter mp server: ws://0.0.0.0:${PORT}/ws (макс. ${MAX_PLAYERS} игроков)`));
}
module.exports = { server, players };
