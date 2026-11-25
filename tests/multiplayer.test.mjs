import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 3123;
const base = `http://127.0.0.1:${port}`;
let child;

class Client {
  constructor(url, name, token = null) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          return false;
        }
        return true;
      });
    });
  }

  async open() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        this.ws.addEventListener('open', resolve, { once: true });
        this.ws.addEventListener('error', reject, { once: true });
      });
    }
    return this;
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  waitFor(predicate, timeout = 4000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`${this.name} timed out waiting for message`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  state(predicate = () => true) {
    return this.waitFor((message) => message.type === 'state' && predicate(message.state));
  }

  close() {
    this.ws.close();
  }
}

async function createRoom() {
  const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 201);
  return response.json();
}

async function joinRoom(code, name, token = null) {
  const client = await new Client(`ws://127.0.0.1:${port}/ws?room=${code}`, name).open();
  client.ws.send(JSON.stringify({ type: 'join', name, token }));
  const welcome = await client.waitFor((message) => message.type === 'welcome');
  await client.state((state) => state.selfId === welcome.playerId);
  return { client, welcome };
}

before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STOP_WINDOW_MS: '150' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Test server did not start: ${serverOutput}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('静态首页可访问且服务端源码不会公开', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /我是大老板/);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/game/engine.mjs`)).status, 404);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
});

test('公开房间列表与快速匹配接口可用', async () => {
  const first = await fetch(`${base}/api/rooms/quickjoin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(first.status, 200);
  const firstData = await first.json();
  assert.equal(firstData.created, true);
  assert.match(firstData.code, /^[A-Z0-9]{6}$/);
  const second = await fetch(`${base}/api/rooms/quickjoin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const secondData = await second.json();
  assert.equal(secondData.code, firstData.code);
  assert.equal(secondData.created, false);
  const listed = await (await fetch(`${base}/api/rooms`)).json();
  assert.equal(listed.rooms.some((room) => room.code === firstData.code), false);
  const joined = await joinRoom(firstData.code, '公开房主');
  const listedAfterJoin = await (await fetch(`${base}/api/rooms`)).json();
  assert.equal(listedAfterJoin.rooms.some((room) => room.code === firstData.code && room.host === '公开房主'), true);
  joined.client.close();
});

test('三位真实客户端可以加入、准备、开局、交易并重连', async () => {
  const { code } = await createRoom();
  const joined = [];
  for (const name of ['阿哲', '小满', '老周']) joined.push(await joinRoom(code, name));
  const clients = joined.map((item) => item.client);
  const identities = joined.map((item) => item.welcome);

  await clients[0].state((state) => state.players.length === 3);
  const unauthorized = clients[1].waitFor((message) => message.type === 'error');
  clients[1].send('start');
  assert.match((await unauthorized).message, /房主/);

  clients.forEach((client) => client.send('ready'));
  await clients[0].state((state) => state.players.every((player) => player.ready));
  clients[0].send('start');
  await Promise.all(clients.map((client) => client.state((state) => state.phase === 'turn')));
  const started = await clients[0].state((state) => state.phase === 'turn');
  assert.equal(started.state.deckCount, 83);
  assert.equal(started.state.hand.length, 5);
  assert.equal(started.state.players.every((player) => player.handCount === 5), true);
  assert.equal(started.state.players.some((player) => player.token), false);
  assert.equal(JSON.stringify(started.state).includes(identities[0].token), false);

  const currentId = started.state.turnPlayerId;
  const currentIndex = identities.findIndex((item) => item.playerId === currentId);
  const current = clients[currentIndex];
  const other = clients[(currentIndex + 1) % clients.length];
  const rejected = other.waitFor((message) => message.type === 'error' && message.message.includes('轮到你'));
  other.send('roll');
  assert.match((await rejected).message, /轮到你/);

  current.send('roll');
  const rolled = await current.state((state) => state.rolled);
  assert.ok(rolled.state.lastRoll >= 1 && rolled.state.lastRoll <= 6);
  current.send('draw');
  const drawn = await current.state((state) => state.phase === 'turn' && !state.rolled && state.turnPlayerId !== currentId);
  assert.equal(drawn.state.phase, 'turn');

  const boss = clients[identities.findIndex((item) => item.playerId === drawn.state.turnPlayerId)];
  const bossWelcome = identities[identities.findIndex((item) => item.playerId === drawn.state.turnPlayerId)];
  boss.send('negotiate');
  const negotiation = await boss.state((state) => state.phase === 'negotiation');
  const total = negotiation.state.currentDeal.total;
  const baseShare = Math.floor(total / 3);
  const allocations = Object.fromEntries(negotiation.state.players.map((player) => [player.id, baseShare]));
  allocations[negotiation.state.players[0].id] += total - baseShare * 3;
  boss.send('propose', { allocations });
  await boss.state((state) => !!state.proposal);
  for (const approverId of negotiation.state.requiredApprovers) {
    if (approverId === bossWelcome.playerId) continue;
    clients[identities.findIndex((item) => item.playerId === approverId)].send('approve');
  }
  await boss.state((state) => state.can.confirm);
  boss.send('confirm');
  await Promise.all(clients.map((client) => client.state((state) => state.completed.length === 1)));
  const settled = await clients[0].state((state) => state.completed.length === 1);
  assert.equal(settled.state.players.reduce((sum, player) => sum + player.cash, 0), total);

  const reconnectIndex = 0;
  const oldIdentity = identities[reconnectIndex];
  clients[reconnectIndex].close();
  await clients[1].state((state) => state.players.find((player) => player.id === oldIdentity.playerId).connected === false);
  const reconnected = await joinRoom(code, '阿哲', oldIdentity.token);
  assert.equal(reconnected.welcome.playerId, oldIdentity.playerId);
  assert.equal(reconnected.client.messages.find((message) => message.type === 'welcome').token, oldIdentity.token);
  await clients[1].state((state) => state.players.find((player) => player.id === oldIdentity.playerId).connected === true);

  reconnected.client.send('chat', { text: '<script>alert(1)</script> 大家好' });
  const chat = await clients[1].state((state) => state.messages.some((message) => message.text.includes('<script>')));
  assert.equal(chat.state.messages.at(-1).system, false);

  clients.forEach((client) => client.close());
  reconnected.client.close();
});
