import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom, GameError, createRoomCode } from './game/engine.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const stopWindowMs = Number(process.env.STOP_WINDOW_MS || 6000);
const rooms = new Map();
const cleanupTimers = new Map();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};
const publicFiles = new Set(['/', '/index.html', '/styles.css', '/app.js', '/favicon.svg']);
const trustProxy = process.env.TRUST_PROXY === '1';
const maxRooms = Number(process.env.MAX_ROOMS || 200);
const roomCreateLimit = Number(process.env.ROOM_CREATE_LIMIT || 5);
const roomCreateWindows = new Map();

function clientIp(request) {
  if (trustProxy) return String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
  return request.socket.remoteAddress || 'unknown';
}

function allowRoomCreation(request) {
  const key = clientIp(request);
  const now = Date.now();
  const recent = (roomCreateWindows.get(key) || []).filter((time) => now - time < 60_000);
  if (recent.length >= roomCreateLimit) return false;
  recent.push(now);
  roomCreateWindows.set(key, recent);
  if (roomCreateWindows.size > 5000) {
    for (const [ip, times] of roomCreateWindows) {
      if (!times.some((time) => now - time < 60_000)) roomCreateWindows.delete(ip);
    }
  }
  return true;
}

function createGameRoom() {
  if (rooms.size >= maxRooms) throw new GameError('服务器房间已满，请稍后再试');
  let code = createRoomCode();
  while (rooms.has(code)) code = createRoomCode();
  const room = new GameRoom(code, { stopWindowMs });
  attachRoom(room);
  rooms.set(code, room);
  scheduleCleanup(room);
  return room;
}

function openRoom(room) {
  return room.state.phase === 'lobby' && room.state.players.length < 6;
}

function publicRooms() {
  return [...rooms.values()]
    .filter((room) => openRoom(room) && room.state.players.length > 0 && [...roomClients(room)].some((ws) => ws.readyState === WebSocket.OPEN))
    .sort((a, b) => b.state.updatedAt - a.state.updatedAt)
    .slice(0, 20)
    .map((room) => ({ code: room.code, count: room.state.players.length, host: room.state.players.find((player) => player.id === room.state.hostId)?.name || '房主' }));
}

function securityHeaders(request) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'",
  };
  if (trustProxy && request.headers['x-forwarded-proto'] === 'https') headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((item) => item?.family === 'IPv4' && !item.internal).map((item) => item.address);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function roomClients(room) {
  return room.clients || new Set();
}

function broadcast(room) {
  for (const ws of roomClients(room)) {
    const playerId = ws.playerId;
    if (ws.readyState === WebSocket.OPEN && playerId) send(ws, { type: 'state', state: room.project(playerId) });
  }
}

function syncStopTimer(room) {
  if (room.stopTimer) clearTimeout(room.stopTimer);
  room.stopTimer = null;
  const pending = room.state.pendingStop;
  if (!pending) return;
  room.stopTimer = setTimeout(() => {
    room.stopTimer = null;
    try {
      room.resolvePendingStop();
    } catch (error) {
      console.error('[SERVER] Failed to resolve stop window:', error.message);
    }
  }, Math.max(0, pending.expiresAt - Date.now()));
}

function scheduleCleanup(room) {
  const existing = cleanupTimers.get(room.code);
  if (existing) clearTimeout(existing);
  if ([...roomClients(room)].some((ws) => ws.readyState === WebSocket.OPEN)) return;
  cleanupTimers.set(room.code, setTimeout(() => {
    if ([...roomClients(room)].some((ws) => ws.readyState === WebSocket.OPEN)) return;
    if (room.stopTimer) clearTimeout(room.stopTimer);
    rooms.delete(room.code);
    cleanupTimers.delete(room.code);
  }, 10 * 60 * 1000));
}

function attachRoom(room) {
  room.clients ||= new Set();
  room.onChange = () => {
    broadcast(room);
    syncStopTimer(room);
  };
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new GameError('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(request) });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()), lanUrls: lanAddresses().map((address) => `http://${address}:${port}`) }));
    return;
  }
  if (url.pathname === '/api/rooms' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(request) });
    response.end(JSON.stringify({ rooms: publicRooms() }));
    return;
  }
  if ((url.pathname === '/api/rooms' || url.pathname === '/api/rooms/quickjoin') && request.method === 'POST') {
    try {
      await readJson(request);
      if (url.pathname === '/api/rooms/quickjoin') {
        const room = [...rooms.values()]
          .filter((item) => openRoom(item) && ([...roomClients(item)].some((ws) => ws.readyState === WebSocket.OPEN) || (item.state.players.length === 0 && Date.now() - item.state.createdAt < 60_000)))
          .sort((a, b) => b.state.players.length - a.state.players.length)[0];
        if (room) {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(request) });
          response.end(JSON.stringify({ code: room.code, created: false }));
          return;
        }
      }
      if (!allowRoomCreation(request)) {
        response.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60', ...securityHeaders(request) });
        response.end(JSON.stringify({ error: '创建房间过于频繁，请稍后再试' }));
        return;
      }
      const room = createGameRoom();
      const status = url.pathname === '/api/rooms/quickjoin' ? 200 : 201;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(request) });
      response.end(JSON.stringify({ code: room.code, created: true }));
    } catch (error) {
      const status = error instanceof GameError && error.message.includes('房间已满') ? 503 : 400;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(request) });
      response.end(JSON.stringify({ error: error.message || 'Invalid request' }));
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  if (!publicFiles.has(url.pathname)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  try {
    const relative = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = resolve(root, `.${relative}`);
    if (!filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      ...securityHeaders(request),
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });

server.on('upgrade', (request, socket, head) => {
  if (!sameOrigin(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const code = String(url.searchParams.get('room') || '').trim().toUpperCase();
  if (url.pathname !== '/ws' || !/^[A-Z0-9]{6}$/.test(code) || !rooms.has(code)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const pendingCleanup = cleanupTimers.get(code);
  if (pendingCleanup) clearTimeout(pendingCleanup);
  cleanupTimers.delete(code);
  wss.handleUpgrade(request, socket, head, (ws) => {
    const room = rooms.get(code);
    ws.room = room;
    ws.playerId = null;
    ws.joined = false;
    ws.alive = true;
    ws.messageTimes = [];
    room.clients.add(ws);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', async (raw) => {
      try {
        const now = Date.now();
        ws.messageTimes = ws.messageTimes.filter((time) => now - time < 10_000);
        if (ws.messageTimes.length >= 50) throw new GameError('消息过于频繁');
        ws.messageTimes.push(now);
        const message = JSON.parse(raw.toString());
        if (!message || typeof message.type !== 'string') throw new GameError('消息格式无效');
        if (message.type === 'join') {
          if (ws.joined) throw new GameError('已经加入房间');
          const token = typeof message.token === 'string' ? message.token.slice(0, 100) : null;
          const returning = token ? room.state.players.find((player) => player.token === token) : null;
          const player = returning || room.addPlayer(message.name);
          for (const other of room.clients) {
            if (other !== ws && other.playerId === player.id && other.readyState === WebSocket.OPEN) other.close(4000, 'reconnected');
          }
          ws.playerId = player.id;
          ws.joined = true;
          if (returning) room.resumePlayer(token);
          send(ws, { type: 'welcome', roomId: room.code, playerId: player.id, token: player.token });
          broadcast(room);
          return;
        }
        if (!ws.joined) throw new GameError('请先加入房间');
        room.handle(ws.playerId, message.type, message.payload || {});
      } catch (error) {
        send(ws, { type: 'error', message: error instanceof GameError ? error.message : '服务器处理失败' });
        if (!(error instanceof GameError)) console.error('[SERVER]', error);
      }
    });
    ws.on('close', () => {
      room.clients.delete(ws);
      if (ws.playerId && ![...room.clients].some((other) => other !== ws && other.playerId === ws.playerId && other.readyState === WebSocket.OPEN)) {
        room.setConnected(ws.playerId, false);
      }
      scheduleCleanup(room);
    });
    ws.on('error', (error) => console.error('[SERVER] WebSocket error:', error.message));
    wss.emit('connection', ws, request);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }
}, 30_000).unref();

server.listen(port, host, () => {
  const addresses = ['localhost', ...lanAddresses()];
  console.log(`[SERVER] BOSS CLUB ready on ${addresses.map((address) => `http://${address}:${port}`).join(' | ')}`);
  console.log(`[SERVER] In-memory rooms; stop window ${stopWindowMs}ms; restart clears rooms.`);
});

function shutdown() {
  for (const room of rooms.values()) {
    if (room.stopTimer) clearTimeout(room.stopTimer);
    for (const ws of room.clients) ws.close(1001, 'server shutdown');
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
