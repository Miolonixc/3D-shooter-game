'use strict';
// Минимальная реализация WebSocket (RFC 6455) без внешних зависимостей.
// Поддерживает текстовые фреймы, ping/pong, close. Этого достаточно для игры.

const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// защита от исчерпания памяти: игровые сообщения крошечные (dir/chat/join — JSON),
// поэтому режем подозрительно большие кадры и разбухший буфер.
const MAX_MESSAGE = 256 * 1024;   // максимум на один кадр
const MAX_BUFFER = 1024 * 1024;   // максимум незавершённых данных в буфере

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// Кодирование исходящего фрейма (сервер не маскирует payload).
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.onMessage = null;
    this.onClose = null;
    this.data = {}; // место для прикладного состояния (id игрока, комната и т.п.)
  }

  send(str) {
    if (!this.alive) return;
    try {
      this.socket.write(encodeFrame(str, 0x1));
    } catch (e) {
      this._terminate();
    }
  }

  close() {
    if (!this.alive) return;
    try {
      this.socket.write(encodeFrame('', 0x8));
      this.socket.end();
    } catch (e) { /* ignore */ }
    this._terminate();
  }

  _terminate() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    if (this.onClose) {
      const cb = this.onClose;
      this.onClose = null;
      cb();
    }
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER) { this._terminate(); return; } // защита от флуда
    const buf = this.buffer;
    let offset = 0;

    while (true) {
      if (buf.length - offset < 2) break;
      const b0 = buf[offset];
      const b1 = buf[offset + 1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = offset + 2;

      if (len === 126) {
        if (buf.length - p < 2) break;
        len = buf.readUInt16BE(p);
        p += 2;
      } else if (len === 127) {
        if (buf.length - p < 8) break;
        const big = buf.readBigUInt64BE(p);
        len = Number(big);
        p += 8;
      }
      if (len > MAX_MESSAGE) { this._terminate(); return; } // слишком большой кадр — рвём

      let mask = null;
      if (masked) {
        if (buf.length - p < 4) break;
        mask = buf.subarray(p, p + 4);
        p += 4;
      }

      if (buf.length - p < len) break; // фрейм ещё не дошёл полностью

      let payload = buf.subarray(p, p + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      p += len;
      offset = p;

      if (opcode === 0x8) {            // close
        this._terminate();
        return;
      } else if (opcode === 0x9) {     // ping -> pong
        try { this.socket.write(encodeFrame(payload, 0xA)); } catch (e) { /* ignore */ }
      } else if (opcode === 0xA) {     // pong
        /* noop */
      } else if (opcode === 0x1 || opcode === 0x0) { // текст / продолжение
        if (this.onMessage) {
          try { this.onMessage(payload.toString('utf8')); } catch (e) { /* ignore */ }
        }
      }
      // бинарные фреймы (0x2) игнорируем — игра общается текстом (JSON)
    }

    this.buffer = buf.subarray(offset);
  }
}

// извлекаем хост (без схемы/порта/пути) из Origin/Host
function hostOf(s) {
  if (!s) return '';
  s = String(s).replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0];
  return s.toLowerCase();
}

// проверка Origin (анти-CSRF для WebSocket). Лениво: пускаем не-браузерные клиенты
// (без Origin), same-origin и localhost; список разрешённых — через SHOOTER_ALLOW_ORIGINS.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allow = process.env.SHOOTER_ALLOW_ORIGINS;
  if (allow) {
    if (allow.trim() === '*') return true;
    if (allow.split(',').map((x) => hostOf(x.trim())).includes(hostOf(origin))) return true;
  }
  const oh = hostOf(origin);
  if (oh && oh === hostOf(req.headers.host)) return true;
  if (oh === 'localhost' || oh === '127.0.0.1') return true;
  return false;
}

// Навешивает обработку upgrade на HTTP-сервер.
function attach(httpServer, path, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    if (path && req.url.split('?')[0] !== path) {
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) { /* ignore */ }
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(key),
      '\r\n'
    ].join('\r\n');

    try {
      socket.write(responseHeaders);
    } catch (e) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    // Node's http.Server даёт сокету дефолтный idle-таймаут (keepAliveTimeout, обычно 5с) —
    // после апгрейда до WS он никому не нужен и тихо рвёт связь при кратком затишье
    // (например, у игрока свернулась вкладка и rAF/отправка state приостановились).
    socket.setTimeout(0);

    const conn = new Conn(socket);
    socket.on('data', (d) => conn._feed(d));
    socket.on('close', () => conn._terminate());
    socket.on('error', () => conn._terminate());

    onConnection(conn, req);
  });
}

module.exports = { attach, encodeFrame, originAllowed, hostOf, MAX_MESSAGE };
