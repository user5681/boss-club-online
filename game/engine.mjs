import { randomBytes, randomUUID } from 'node:crypto';
import { INVESTORS, DEALS, CARD_TYPES, buildDeck, shuffle, dealPayout } from './data.mjs';

export class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
  }
}

const assert = (condition, message) => {
  if (!condition) throw new GameError(message);
};

const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
const pad = (value) => String(value).padStart(2, '0');

export function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

export function createPlayerToken() {
  return randomBytes(24).toString('base64url');
}

export function createRoom(code, options = {}) {
  return new GameRoom(code, options);
}

export class GameRoom {
  constructor(code, options = {}) {
    this.code = code;
    this.stopWindowMs = options.stopWindowMs ?? 6000;
    this.random = options.random || Math.random;
    this.onChange = null;
    this.state = {
      code,
      phase: 'lobby',
      hostId: null,
      players: [],
      pool: [],
      deck: [],
      discard: [],
      marker: 0,
      turnIndex: 0,
      rolled: false,
      lastRoll: null,
      bossId: null,
      proposal: null,
      approvals: [],
      traveled: [],
      proxies: {},
      clanInPlay: [],
      pendingStop: null,
      completed: [],
      ended: false,
      winnerId: null,
      endReason: '',
      messages: [],
      revision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  touch() {
    this.state.revision += 1;
    this.state.updatedAt = Date.now();
    this.onChange?.(this);
  }

  message(text, playerId = null, system = true) {
    const player = this.player(playerId);
    this.state.messages.push({
      id: randomUUID(),
      playerId,
      name: system ? '系统' : player?.name || '玩家',
      text: String(text).slice(0, 160),
      system,
      time: Date.now(),
    });
    if (this.state.messages.length > 40) this.state.messages.shift();
  }

  player(playerId) {
    return this.state.players.find((player) => player.id === playerId);
  }

  currentPlayer() {
    return this.state.players[this.state.turnIndex];
  }

  addPlayer(name, token = createPlayerToken()) {
    assert(this.state.phase === 'lobby', '游戏已经开始，不能加入新玩家');
    assert(this.state.players.length < 6, '房间已满（最多 6 人）');
    const clean = cleanName(name);
    assert(clean.length >= 1, '昵称不能为空');
    const index = this.state.players.length;
    const player = {
      id: randomUUID(),
      name: clean,
      token,
      initial: clean[0],
      investor: INVESTORS[index].id,
      investors: [],
      cash: 0,
      ready: false,
      connected: true,
      hand: [],
      lastChatAt: 0,
    };
    this.state.players.push(player);
    if (!this.state.hostId) this.state.hostId = player.id;
    this.message(`${clean} 加入了房间`, player.id);
    this.touch();
    return player;
  }

  resumePlayer(token) {
    const player = this.state.players.find((item) => item.token === token);
    assert(player, '房间令牌无效');
    player.connected = true;
    this.message(`${player.name} 重新连接`, player.id);
    this.touch();
    return player;
  }

  setConnected(playerId, connected) {
    const player = this.player(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    this.message(`${player.name} ${connected ? '已连接' : '暂时离线'}`, player.id);
    this.touch();
  }

  handle(playerId, type, payload = {}) {
    const player = this.player(playerId);
    assert(player, '请先加入房间');
    switch (type) {
      case 'ready': this.toggleReady(player); break;
      case 'start': this.start(player); break;
      case 'roll': this.roll(player); break;
      case 'draw': this.draw(player); break;
      case 'negotiate': this.negotiate(player); break;
      case 'propose': this.propose(player, payload.allocations); break;
      case 'approve': this.approve(player); break;
      case 'confirm': this.confirm(player); break;
      case 'cancel': this.cancel(player); break;
      case 'endTurn': this.endTurn(player); break;
      case 'playCard': this.playCard(player, payload); break;
      case 'discard': this.discard(player, payload.cardIds); break;
      case 'chat': this.chat(player, payload.text); break;
      case 'restart': this.restart(player); break;
      default: throw new GameError('未知动作');
    }
  }

  toggleReady(player) {
    assert(this.state.phase === 'lobby', '只有等待阶段可以准备');
    player.ready = !player.ready;
    this.message(`${player.name}${player.ready ? '已准备' : '取消准备'}`, player.id);
    this.touch();
  }

  start(player) {
    assert(this.state.phase === 'lobby', '游戏已经开始');
    assert(player.id === this.state.hostId, '只有房主可以开始');
    assert(this.state.players.length >= 3, '至少需要 3 位玩家');
    assert(this.state.players.every((item) => item.connected && item.ready), '所有玩家都必须在线并准备');
    const investors = shuffle(INVESTORS.map((item) => item.id), this.random);
    const counts = this.state.players.map((_, index) => this.state.players.length === 3 ? 2 : 1);
    let cursor = 0;
    this.state.players.forEach((item, index) => {
      item.investors = investors.slice(cursor, cursor + counts[index]);
      cursor += counts[index];
      item.cash = 0;
      item.ready = false;
    });
    this.state.pool = investors.slice(cursor);
    this.state.deck = buildDeck(this.random);
    this.state.players.forEach((item) => {
      item.hand = this.state.deck.splice(0, 5);
    });
    this.state.marker = Math.floor(this.random() * DEALS.length);
    const firstInvestorOwner = this.state.players.find((item) => item.investors.includes('A'));
    this.state.turnIndex = firstInvestorOwner ? this.state.players.indexOf(firstInvestorOwner) : 0;
    this.state.phase = 'turn';
    this.state.rolled = false;
    this.state.lastRoll = null;
    this.message('游戏开始，每人抽取 5 张影响力牌', null);
    this.touch();
  }

  roll(player) {
    this.assertTurn(player);
    assert(!this.state.rolled, '本回合已经掷过骰子');
    const roll = Math.floor(this.random() * 6) + 1;
    let marker = this.state.marker;
    for (let count = 0; count < roll; count += 1) {
      do {
        marker = (marker + 1) % DEALS.length;
      } while (this.state.completed.includes(marker));
    }
    this.state.marker = marker;
    this.state.rolled = true;
    this.state.lastRoll = roll;
    this.message(`${player.name} 掷出 ${roll} 点，移动到「${DEALS[marker].title}」`, player.id);
    this.touch();
  }

  draw(player) {
    this.assertTurn(player);
    assert(this.state.rolled, '需要先掷骰才能抽牌');
    if (this.state.deck.length < 3) {
      this.state.deck = shuffle([...this.state.deck, ...this.state.discard], this.random);
      this.state.discard = [];
    }
    player.hand.push(...this.state.deck.splice(0, 3));
    this.message(`${player.name} 抽取了 3 张牌`, player.id);
    if (player.hand.length > 12) {
      this.state.phase = 'discard';
      this.state.discardRequired = player.hand.length - 12;
      this.message(`${player.name} 需要弃掉 ${this.state.discardRequired} 张牌`, player.id);
    } else {
      this.advanceTurn(this.state.turnIndex);
    }
    this.touch();
  }

  negotiate(player) {
    this.assertTurn(player);
    assert(this.state.phase === 'turn', '当前不在谈判阶段');
    this.state.phase = 'negotiation';
    this.state.bossId = player.id;
    this.state.proposal = null;
    this.state.approvals = [];
    this.message(`${player.name} 发起「${DEALS[this.state.marker].title}」谈判`, player.id);
    this.touch();
  }

  propose(player, allocations) {
    this.assertNegotiation(player);
    assert(player.id === this.state.bossId, '只有当前老板可以提出分配方案');
    assert(!this.state.pendingStop, '请等待叫停窗口结束');
    const ids = this.state.players.map((item) => item.id).sort();
    assert(allocations && typeof allocations === 'object' && !Array.isArray(allocations), '分配格式无效');
    const keys = Object.keys(allocations).sort();
    assert(keys.length === ids.length && keys.every((key, index) => key === ids[index]), '分配名单不完整');
    const values = ids.map((id) => allocations[id]);
    assert(values.every((value) => Number.isSafeInteger(value) && value >= 0), '分配金额必须是非负整数');
    const total = values.reduce((sum, value) => sum + value, 0);
    assert(total === dealPayout(DEALS[this.state.marker]), `分配总额必须等于 ${dealPayout(DEALS[this.state.marker])}`);
    const required = this.requiredApprovers();
    this.state.proposal = { allocations: { ...allocations }, version: (this.state.proposal?.version || 0) + 1 };
    this.state.approvals = required.includes(player.id) ? [player.id] : [];
    this.message(`${player.name} 提出了新的分配方案`, player.id);
    this.touch();
  }

  approve(player) {
    this.assertNegotiation(player);
    assert(!this.state.pendingStop, '请等待叫停窗口结束');
    assert(this.state.proposal, '还没有分配方案');
    const required = this.requiredApprovers();
    assert(required.includes(player.id), '你不控制这笔交易所需的投资者');
    if (!this.state.approvals.includes(player.id)) this.state.approvals.push(player.id);
    this.message(`${player.name} 同意了当前方案`, player.id);
    this.touch();
  }

  confirm(player) {
    this.assertNegotiation(player);
    assert(player.id === this.state.bossId, '只有当前老板可以宣布成交');
    assert(!this.state.pendingStop, '请等待叫停窗口结束');
    assert(this.state.proposal, '请先提出分配方案');
    const required = this.requiredApprovers();
    assert(this.requirementsMet(), '所需投资者仍缺席，请用家族代理人或招募补齐');
    assert(required.length > 0 && required.every((id) => this.state.approvals.includes(id)), '所需投资者尚未全部同意');
    const bossIndex = this.state.players.findIndex((item) => item.id === this.state.bossId);
    const total = dealPayout(DEALS[this.state.marker]);
    this.state.players.forEach((item) => { item.cash += this.state.proposal.allocations[item.id] || 0; });
    const closed = this.state.marker;
    this.state.completed.push(closed);
    this.message(`「${DEALS[closed].title}」以 ${total.toLocaleString('en-US')} 成交`, player.id);
    this.cleanupNegotiation();
    if (this.state.completed.length >= 15) {
      this.finishGame('十五笔交易全部完成');
      return;
    }
    if (this.state.completed.length >= 10 && Math.floor(this.random() * 6) < this.state.completed.length - 9) {
      this.finishGame(`第 ${this.state.completed.length} 笔成交后触发终局判定`);
      return;
    }
    let marker = closed;
    do {
      marker = (marker + 1) % DEALS.length;
    } while (this.state.completed.includes(marker));
    this.state.marker = marker;
    this.state.turnIndex = (bossIndex + 1) % this.state.players.length;
    this.state.phase = 'turn';
    this.state.rolled = false;
    this.state.lastRoll = null;
    delete this.state.discardRequired;
    this.touch();
  }

  cancel(player) {
    this.assertNegotiation(player);
    assert(player.id === this.state.bossId, '只有当前老板可以结束谈判');
    assert(!this.state.pendingStop, '请等待叫停窗口结束');
    const bossIndex = this.state.players.findIndex((item) => item.id === this.state.bossId);
    this.message(`${player.name} 结束了本轮谈判`, player.id);
    this.cleanupNegotiation();
    this.state.turnIndex = (bossIndex + 1) % this.state.players.length;
    this.state.phase = 'turn';
    this.state.rolled = false;
    this.state.lastRoll = null;
    delete this.state.discardRequired;
    this.touch();
  }

  endTurn(player) {
    this.assertTurn(player);
    assert(this.state.phase === 'turn', '谈判中请由老板结束谈判');
    this.message(`${player.name} 结束回合`, player.id);
    this.advanceTurn(this.state.turnIndex);
    this.touch();
  }

  playCard(player, payload) {
    this.assertNegotiation(player);
    const card = payload.cardId ? player.hand.find((item) => item.id === payload.cardId) : null;
    if (card?.type === 'stop') {
      this.playStop(player, card);
      return;
    }
    assert(!this.state.pendingStop, '请等待叫停窗口结束');
    assert(card || Array.isArray(payload.cardIds), '请选择要打出的牌');
    if (card?.type === 'clan') {
      assert(card.investor && !this.state.proxies[card.investor], '该投资者已有家族代理人');
      player.hand = player.hand.filter((item) => item.id !== card.id);
      this.state.proxies[card.investor] = player.id;
      this.state.clanInPlay.push({ card, playerId: player.id, investor: card.investor });
      this.message(`${player.name} 打出${INVESTORS.find((item) => item.id === card.investor).short}家族代理人`, player.id);
      this.state.approvals = [];
      this.touch();
      return;
    }
    if (card?.type === 'travel') {
      const investor = payload.investor;
      assert(INVESTORS.some((item) => item.id === investor), '请选择旅行目标');
      if (card.investor) assert(card.investor === investor, '这张旅行令只能作用于对应投资者');
      const proxy = this.state.clanInPlay.find((item) => item.investor === investor);
      assert(proxy || this.investorExists(investor), '目标投资者不存在');
      player.hand = player.hand.filter((item) => item.id !== card.id);
      this.armStop('travel', player.id, [card.id], {
        investor,
        targetType: proxy ? 'clan' : 'investor',
        clanCardId: proxy?.card.id || null,
      });
      this.message(`${player.name} 对${INVESTORS.find((item) => item.id === investor).short}打出旅行令`, player.id);
      this.touch();
      return;
    }
    if (Array.isArray(payload.cardIds)) {
      const ids = payload.cardIds;
      assert(Array.isArray(ids) && ids.length === 3 && new Set(ids).size === 3, '招募令必须一次选择 3 张');
      const cards = ids.map((id) => player.hand.find((item) => item.id === id));
      assert(cards.every((item) => item?.type === 'recruit'), '选择的牌必须全是招募令');
      const investor = payload.investor;
      assert(this.investorExists(investor), '请选择要招募的投资者');
      player.hand = player.hand.filter((item) => !ids.includes(item.id));
      this.armStop('recruit', player.id, ids, { investor });
      this.message(`${player.name} 打出 3 张招募令，目标${INVESTORS.find((item) => item.id === investor).short}`, player.id);
      this.touch();
      return;
    }
    if (card?.type === 'boss') {
      player.hand = player.hand.filter((item) => item.id !== card.id);
      this.armStop('boss', player.id, [card.id], {});
      this.message(`${player.name} 宣告“我是老板”`, player.id);
      this.touch();
      return;
    }
    throw new GameError('这张牌目前不能打出');
  }

  playStop(player, card) {
    const pending = this.state.pendingStop;
    assert(pending, '当前没有可叫停的效果');
    assert(pending.actorId !== player.id, '不能叫停自己打出的牌');
    player.hand = player.hand.filter((item) => item.id !== card.id);
    this.state.discard.push(card, ...pending.cards.map((id) => ({ id, type: 'canceled', investor: null })));
    this.state.pendingStop = null;
    this.state.approvals = [];
    this.message(`${player.name} 叫停了${this.player(pending.actorId).name}的效果`, player.id);
    this.touch();
  }

  resolvePendingStop() {
    const pending = this.state.pendingStop;
    if (!pending) return;
    const actor = this.player(pending.actorId);
    assert(actor, '出牌玩家已不存在');
    this.state.pendingStop = null;
    if (pending.kind === 'travel') {
      this.state.discard.push(...pending.cards.map((id) => ({ id, type: 'travel', investor: pending.investor })));
      if (pending.targetType === 'clan') {
        const proxy = this.state.clanInPlay.find((item) => item.card.id === pending.clanCardId);
        if (proxy) {
          this.state.discard.push(proxy.card);
          this.state.clanInPlay = this.state.clanInPlay.filter((item) => item !== proxy);
          delete this.state.proxies[pending.investor];
        }
      } else if (!this.state.traveled.includes(pending.investor)) {
        this.state.traveled.push(pending.investor);
      }
    } else if (pending.kind === 'recruit') {
      const oldOwner = this.state.players.find((item) => item.investors.includes(pending.investor));
      if (oldOwner) oldOwner.investors = oldOwner.investors.filter((id) => id !== pending.investor);
      this.state.pool = this.state.pool.filter((id) => id !== pending.investor);
      actor.investors.push(pending.investor);
      this.state.discard.push(...pending.cards.map((id) => ({ id, type: 'recruit', investor: null })));
    } else if (pending.kind === 'boss') {
      this.state.bossId = actor.id;
      this.state.approvals = [];
      this.state.discard.push(...pending.cards.map((id) => ({ id, type: 'boss', investor: null })));
    }
    this.message(`${actor.name} 的${pending.kind === 'boss' ? '老板卡' : pending.kind === 'recruit' ? '招募' : '旅行令'}效果生效`, actor.id);
    this.touch();
  }

  discard(player, cardIds) {
    assert(this.state.phase === 'discard', '当前不需要弃牌');
    assert(player.id === this.currentPlayer().id, '只能由当前玩家弃牌');
    const required = this.state.discardRequired;
    assert(Array.isArray(cardIds) && cardIds.length === required && new Set(cardIds).size === required, `请选择 ${required} 张牌`);
    assert(cardIds.every((id) => player.hand.some((card) => card.id === id)), '选择的牌不在你的手牌中');
    const discarded = player.hand.filter((card) => cardIds.includes(card.id));
    player.hand = player.hand.filter((card) => !cardIds.includes(card.id));
    this.state.discard.push(...discarded);
    this.message(`${player.name} 弃掉了 ${required} 张牌`, player.id);
    this.advanceTurn(this.state.turnIndex);
    this.touch();
  }

  chat(player, text) {
    const clean = String(text || '').trim().slice(0, 80);
    assert(clean, '消息不能为空');
    assert(Date.now() - player.lastChatAt >= 500, '发言太快，请稍候');
    player.lastChatAt = Date.now();
    this.message(clean, player.id, false);
    this.touch();
  }

  restart(player) {
    assert(this.state.phase === 'ended', '只有游戏结束后才能重开');
    assert(player.id === this.state.hostId, '只有房主可以重开');
    this.state.players.forEach((item) => {
      item.investors = [];
      item.cash = 0;
      item.hand = [];
      item.ready = false;
    });
    Object.assign(this.state, {
      phase: 'lobby', pool: [], deck: [], discard: [], marker: 0, turnIndex: 0,
      rolled: false, lastRoll: null, bossId: null, proposal: null, approvals: [],
      traveled: [], proxies: {}, clanInPlay: [], pendingStop: null, completed: [],
      ended: false, winnerId: null, endReason: '',
    });
    delete this.state.discardRequired;
    this.message('房主重新打开了房间', player.id);
    this.touch();
  }

  assertTurn(player) {
    assert(!this.state.ended, '游戏已经结束');
    assert(this.state.phase === 'turn', '现在不是行动阶段');
    assert(this.currentPlayer().id === player.id, '还没有轮到你');
  }

  assertNegotiation(player) {
    assert(!this.state.ended, '游戏已经结束');
    assert(this.state.phase === 'negotiation', '当前不在谈判阶段');
    assert(this.state.players.some((item) => item.id === player.id), '玩家不存在');
  }

  advanceTurn(index) {
    this.state.turnIndex = (index + 1) % this.state.players.length;
    this.state.phase = 'turn';
    this.state.rolled = false;
    this.state.lastRoll = null;
    this.state.bossId = null;
    this.state.proposal = null;
    this.state.approvals = [];
    this.state.traveled = [];
    this.state.proxies = {};
    this.state.clanInPlay = [];
    delete this.state.discardRequired;
  }

  cleanupNegotiation() {
    this.state.clanInPlay.forEach((proxy) => {
      const owner = this.player(proxy.playerId);
      if (owner && !owner.hand.some((card) => card.id === proxy.card.id)) owner.hand.push(proxy.card);
    });
    this.state.bossId = null;
    this.state.proposal = null;
    this.state.approvals = [];
    this.state.traveled = [];
    this.state.proxies = {};
    this.state.clanInPlay = [];
    this.state.pendingStop = null;
  }

  finishGame(reason) {
    this.state.phase = 'ended';
    this.state.ended = true;
    this.state.endReason = reason;
    const sorted = [...this.state.players].sort((a, b) => b.cash - a.cash);
    this.state.winnerId = sorted[0]?.id || null;
    this.message(`游戏结束，${sorted[0]?.name || '无人'}获胜`, null);
  }

  investorExists(investor) {
    return this.state.pool.includes(investor) || this.state.players.some((player) => player.investors.includes(investor));
  }

  requirementsMet() {
    return DEALS[this.state.marker].required.every((investor) => {
      if (this.state.proxies[investor]) return true;
      return !this.state.traveled.includes(investor) && this.investorExists(investor);
    });
  }

  requiredApprovers() {
    const approvers = [];
    DEALS[this.state.marker].required.forEach((investor) => {
      let owner = null;
      if (this.state.proxies[investor]) owner = this.state.proxies[investor];
      else if (!this.state.traveled.includes(investor)) owner = this.state.players.find((player) => player.investors.includes(investor))?.id || null;
      if (owner && !approvers.includes(owner)) approvers.push(owner);
    });
    return approvers;
  }

  pendingStopView() {
    const pending = this.state.pendingStop;
    if (!pending) return null;
    const actor = this.player(pending.actorId);
    const target = pending.investor ? INVESTORS.find((item) => item.id === pending.investor) : null;
    return {
      kind: pending.kind,
      actorId: pending.actorId,
      actorName: actor?.name || '玩家',
      expiresAt: pending.expiresAt,
      target: target?.name || null,
      cardCount: pending.cards.length,
    };
  }

  armStop(kind, actorId, cards, target) {
    this.state.pendingStop = {
      id: randomUUID(),
      kind,
      actorId,
      cards,
      ...target,
      expiresAt: Date.now() + this.stopWindowMs,
    };
    this.state.approvals = [];
  }

  project(playerId) {
    const state = this.state;
    const me = this.player(playerId);
    const current = this.currentPlayer();
    const required = state.phase === 'negotiation' ? this.requiredApprovers() : [];
    const deal = DEALS[state.marker];
    return {
      code: state.code,
      phase: state.phase,
      revision: state.revision,
      hostId: state.hostId,
      selfId: playerId,
      players: state.players.map((player, index) => ({
        id: player.id,
        name: player.name,
        initial: player.initial,
        seat: index,
        color: INVESTORS[index].color,
        avatarClass: INVESTORS[index].avatarClass,
        investors: player.investors,
        cash: player.cash,
        ready: player.ready,
        connected: player.connected,
        handCount: player.hand.length,
      })),
      hand: me?.hand || [],
      pool: state.pool,
      deckCount: state.deck.length,
      discardCount: state.discard.length,
      marker: state.marker,
      completed: state.completed,
      turnPlayerId: current?.id || null,
      rolled: state.rolled,
      lastRoll: state.lastRoll,
      bossId: state.bossId,
      proposal: state.proposal,
      approvals: state.approvals,
      requiredApprovers: required,
      requirementsMet: state.phase === 'negotiation' ? this.requirementsMet() : true,
      traveled: state.traveled,
      proxies: state.proxies,
      pendingStop: this.pendingStopView(),
      discardRequired: state.discardRequired || 0,
      currentDeal: { ...deal, total: dealPayout(deal) },
      ended: state.ended,
      winnerId: state.winnerId,
      endReason: state.endReason,
      messages: state.messages,
      can: {
        ready: state.phase === 'lobby',
        start: state.phase === 'lobby' && playerId === state.hostId,
        roll: state.phase === 'turn' && current?.id === playerId && !state.rolled,
        draw: state.phase === 'turn' && current?.id === playerId && state.rolled,
        negotiate: state.phase === 'turn' && current?.id === playerId,
        endTurn: state.phase === 'turn' && current?.id === playerId,
        propose: state.phase === 'negotiation' && state.bossId === playerId && !state.pendingStop,
        approve: state.phase === 'negotiation' && required.includes(playerId) && !state.pendingStop,
        confirm: state.phase === 'negotiation' && state.bossId === playerId && !state.pendingStop && !!state.proposal && this.requirementsMet() && required.length > 0 && required.every((id) => state.approvals.includes(id)),
        cancel: state.phase === 'negotiation' && state.bossId === playerId && !state.pendingStop,
        playCard: state.phase === 'negotiation' && !state.pendingStop,
        stop: !!state.pendingStop && state.pendingStop.actorId !== playerId,
        discard: state.phase === 'discard' && current?.id === playerId,
        restart: state.phase === 'ended' && playerId === state.hostId,
      },
    };
  }
}

export { INVESTORS, DEALS, CARD_TYPES, dealPayout, pad };
