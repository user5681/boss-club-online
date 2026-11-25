import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom, GameError, DEALS, dealPayout } from '../game/engine.mjs';
import { buildDeck } from '../game/data.mjs';

function setupRoom(playerCount = 3, random = () => 0.42) {
  const room = new GameRoom('ABC234', { random, stopWindowMs: 1000 });
  const players = Array.from({ length: playerCount }, (_, index) => room.addPlayer(`玩家${index + 1}`, `token-${index + 1}`));
  players.forEach((player) => room.handle(player.id, 'ready'));
  room.handle(players[0].id, 'start');
  return { room, players };
}

function evenAllocations(room) {
  const total = dealPayout(DEALS[room.state.marker]);
  const base = Math.floor(total / room.state.players.length);
  const allocations = Object.fromEntries(room.state.players.map((player) => [player.id, base]));
  allocations[room.state.players[0].id] += total - base * room.state.players.length;
  return allocations;
}

function completeDeal(room) {
  const boss = room.currentPlayer();
  room.handle(boss.id, 'negotiate');
  room.handle(boss.id, 'propose', { allocations: evenAllocations(room) });
  room.requiredApprovers().forEach((id) => room.handle(id, 'approve'));
  room.handle(boss.id, 'confirm');
}

test('牌堆包含准确的98张牌', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 98);
  const counts = deck.reduce((result, card) => {
    result[card.type] = (result[card.type] || 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, { clan: 24, travel: 21, recruit: 33, boss: 10, stop: 10 });
  assert.equal(new Set(deck.map((card) => card.id)).size, 98);
});

test('3人局正确发牌并隐藏私密信息', () => {
  const { room, players } = setupRoom();
  assert.equal(room.state.phase, 'turn');
  assert.equal(room.state.deck.length, 83);
  assert.equal(room.state.pool.length, 0);
  players.forEach((player) => {
    assert.equal(player.hand.length, 5);
    assert.equal(player.investors.length, 2);
  });
  const view = room.project(players[0].id);
  assert.equal(view.hand.length, 5);
  assert.equal(view.players[1].hand, undefined);
  assert.equal(view.players[1].token, undefined);
  assert.equal(JSON.stringify(view).includes('token-'), false);
});

test('4至6人局正确分配中央投资者牌', () => {
  for (const count of [4, 5, 6]) {
    const { room } = setupRoom(count);
    assert.equal(room.state.pool.length, 6 - count);
    assert.equal(room.state.players.every((player) => player.investors.length === 1), true);
  }
});

test('非法分配金额会被服务端拒绝', () => {
  const { room } = setupRoom();
  const boss = room.currentPlayer();
  room.handle(boss.id, 'negotiate');
  const total = dealPayout(DEALS[room.state.marker]);
  const invalid = Object.fromEntries(room.state.players.map((player) => [player.id, 0]));
  invalid[boss.id] = total + 1;
  assert.throws(() => room.handle(boss.id, 'propose', { allocations: invalid }), GameError);
  invalid[boss.id] = -1;
  assert.throws(() => room.handle(boss.id, 'propose', { allocations: invalid }), GameError);
});

test('非行动玩家不能掷骰或成交', () => {
  const { room, players } = setupRoom();
  const current = room.currentPlayer();
  const other = players.find((player) => player.id !== current.id);
  assert.throws(() => room.handle(other.id, 'roll'), GameError);
  room.handle(current.id, 'negotiate');
  assert.throws(() => room.handle(other.id, 'confirm'), GameError);
});

test('掷骰抽牌、12张上限与弃牌后换人', () => {
  const { room } = setupRoom();
  const current = room.currentPlayer();
  current.hand = Array.from({ length: 12 }, (_, index) => ({ id: `hand-${index}`, type: 'clan', investor: 'A' }));
  room.handle(current.id, 'roll');
  room.handle(current.id, 'draw');
  assert.equal(current.hand.length, 15);
  assert.equal(room.state.phase, 'discard');
  assert.equal(room.state.discardRequired, 3);
  room.handle(current.id, 'discard', { cardIds: ['hand-0', 'hand-1', 'hand-2'] });
  assert.equal(current.hand.length, 12);
  assert.equal(room.state.phase, 'turn');
  assert.notEqual(room.currentPlayer().id, current.id);
});

test('交易需要所需投资者同意且资金守恒', () => {
  const { room, players } = setupRoom();
  const boss = room.currentPlayer();
  const beforeCash = players.reduce((sum, player) => sum + player.cash, 0);
  const expectedPayout = dealPayout(DEALS[room.state.marker]);
  room.handle(boss.id, 'negotiate');
  room.handle(boss.id, 'propose', { allocations: evenAllocations(room) });
  assert.throws(() => room.handle(boss.id, 'confirm'), GameError);
  room.requiredApprovers().forEach((id) => room.handle(id, 'approve'));
  room.handle(boss.id, 'confirm');
  assert.equal(room.state.completed.length, 1);
  assert.equal(players.reduce((sum, player) => sum + player.cash, 0), beforeCash + expectedPayout);
  assert.equal(room.state.phase, 'turn');
});

test('家族代理人、旅行令与叫停形成正确响应链', () => {
  const { room, players } = setupRoom();
  const boss = room.currentPlayer();
  const other = players.find((player) => player.id !== boss.id);
  const investor = DEALS[room.state.marker].required.find((id) => !boss.investors.includes(id)) || DEALS[room.state.marker].required[0];
  boss.hand = [
    { id: 'clan-test', type: 'clan', investor },
    { id: 'travel-test', type: 'travel', investor },
  ];
  other.hand = [{ id: 'stop-test', type: 'stop', investor: null }];
  room.handle(boss.id, 'negotiate');
  room.handle(boss.id, 'playCard', { cardId: 'clan-test' });
  assert.equal(room.state.proxies[investor], boss.id);
  room.handle(boss.id, 'playCard', { cardId: 'travel-test', investor });
  assert.equal(room.state.pendingStop.kind, 'travel');
  room.handle(other.id, 'playCard', { cardId: 'stop-test' });
  assert.equal(room.state.pendingStop, null);
  assert.equal(room.state.proxies[investor], boss.id);
  assert.equal(room.state.clanInPlay.length, 1);
  assert.equal(other.hand.length, 0);
});

test('三张招募令永久转移投资者', () => {
  const { room, players } = setupRoom();
  const actor = room.currentPlayer();
  const targetOwner = players.find((player) => player.id !== actor.id && player.investors.length > 0);
  const investor = targetOwner.investors[0];
  actor.hand = [1, 2, 3].map((index) => ({ id: `recruit-${index}`, type: 'recruit', investor: null }));
  room.handle(actor.id, 'negotiate');
  room.handle(actor.id, 'playCard', { cardIds: ['recruit-1', 'recruit-2', 'recruit-3'], investor });
  room.resolvePendingStop();
  assert.equal(targetOwner.investors.includes(investor), false);
  assert.equal(actor.investors.includes(investor), true);
});

test('第10笔按1/6概率触发终局', () => {
  const { room } = setupRoom();
  room.random = () => 0;
  for (let index = 0; index < 10; index += 1) completeDeal(room);
  assert.equal(room.state.completed.length, 10);
  assert.equal(room.state.ended, true);
  assert.match(room.state.endReason, /第 10 笔/);
});

test('第15笔必定结束且可以重开', () => {
  const { room, players } = setupRoom();
  room.random = () => 0.99;
  for (let index = 0; index < 15; index += 1) completeDeal(room);
  assert.equal(room.state.completed.length, 15);
  assert.equal(room.state.ended, true);
  const totalDeals = DEALS.reduce((sum, deal) => sum + dealPayout(deal), 0);
  assert.equal(players.reduce((sum, player) => sum + player.cash, 0), totalDeals);
  room.handle(players[0].id, 'restart');
  assert.equal(room.state.phase, 'lobby');
  assert.equal(room.state.completed.length, 0);
});
