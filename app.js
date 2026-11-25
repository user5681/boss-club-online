const CARD_TYPES = {
  clan: { label: '家族代理人', symbol: '族', code: 'CLAN' },
  travel: { label: '旅行令', symbol: '旅', code: 'TRAVEL' },
  recruit: { label: '招募令', symbol: '招', code: 'RECRUIT' },
  stop: { label: '叫停卡', symbol: '停', code: 'STOP' },
  boss: { label: '老板卡', symbol: '主', code: 'BOSS' },
};

const INVESTORS = [
  { id: 'A', name: '莱恩家族', short: '莱恩' },
  { id: 'B', name: '莫里斯家族', short: '莫里斯' },
  { id: 'C', name: '欧阳家族', short: '欧阳' },
  { id: 'D', name: '苏菲家族', short: '苏菲' },
  { id: 'E', name: '塔克家族', short: '塔克' },
  { id: 'F', name: '王氏家族', short: '王氏' },
];

const DEAL_TITLES = ['云端新城计划', '海岸快线', '星光酒店集团', '绿洲能源', '城市光影院线', '远洋航运', '未来制造工厂', '中央商业中心', '云端数据', '度假群岛', '城市电车', '奇想主题乐园', '星际太空港', '国际会展中心', '世界之巅'];
const $ = (selector) => document.querySelector(selector);
const pad = (value) => String(value).padStart(2, '0');
const money = (value) => {
  const amount = Math.round(Number(value) || 0);
  if (Math.abs(amount) >= 1_000_000) return `$${Number((amount / 1_000_000).toFixed(1))}M`;
  if (Math.abs(amount) >= 1000) return `$${Number((amount / 1000).toFixed(1))}K`;
  return `$${amount}`;
};

let state = null;
let socket = null;
let connected = false;
let manualClose = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let toastTimer = null;
let draftAllocations = {};
let lastProposalVersion = -1;
let discardSelection = new Set();
let recruitSelection = new Set();
let endShownRevision = -1;
let session = loadSession();

function loadSession() {
  try {
    let saved = JSON.parse(sessionStorage.getItem('bossclub.session') || 'null');
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem('bossclub.session') || 'null');
      if (legacy?.roomId && legacy?.name) {
        saved = legacy;
        sessionStorage.setItem('bossclub.session', JSON.stringify(legacy));
        localStorage.removeItem('bossclub.session');
      }
    }
    return saved?.roomId && saved?.name ? saved : null;
  } catch {
    return null;
  }
}

function saveSession() {
  if (session) sessionStorage.setItem('bossclub.session', JSON.stringify(session));
  else sessionStorage.removeItem('bossclub.session');
  localStorage.removeItem('bossclub.session');
}

function setConnection(label, lost = false) {
  $('#connectionStatus').textContent = label;
  $('#connectionDot').classList.toggle('connection-lost', lost);
}

function showToast(message, error = false) {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('is-error', error);
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast('尚未连接到服务器', true);
    return false;
  }
  socket.send(JSON.stringify({ type, payload }));
  return true;
}

function connect() {
  if (!session) return;
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  clearTimeout(reconnectTimer);
  manualClose = false;
  setConnection('连接中…', true);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?room=${encodeURIComponent(session.roomId)}`;
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () => {
    if (socket !== current) return;
    reconnectAttempts = 0;
    current.send(JSON.stringify({ type: 'join', name: session.name, token: session.token || null }));
  };
  current.onmessage = (event) => {
    if (socket !== current) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      session = { ...session, playerId: message.playerId, token: message.token };
      saveSession();
      $('#leaveButton').hidden = false;
      setConnection('已连接');
    } else if (message.type === 'state') {
      connected = true;
      state = message.state;
      setConnection('已连接');
      renderAll();
      handlePhase();
    } else if (message.type === 'error') {
      showToast(message.message, true);
      if (state?.phase === 'lobby') $('#waitingError').textContent = message.message;
    }
  };
  current.onclose = () => {
    if (socket !== current) return;
    connected = false;
    setConnection('正在重连…', true);
    $('#chatInput').disabled = true;
    $('#chatForm button').disabled = true;
    if (manualClose) return;
    reconnectAttempts += 1;
    if (reconnectAttempts > 2) setConnection('服务唤醒中…', true);
    if (reconnectAttempts > 12) {
      session = null;
      saveSession();
      state = null;
      showLobbyEntry('房间可能已不存在或服务器已重启，请重新创建或加入。');
      return;
    }
    reconnectTimer = setTimeout(connect, Math.min(15000, 1500 * reconnectAttempts));
  };
  current.onerror = () => {};
}

async function createRoom(name) {
  const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('创建房间失败，请确认服务器正在运行');
  const data = await response.json();
  session = { roomId: data.code, name, token: null, playerId: null };
  saveSession();
  connect();
}

function joinRoom(code, name) {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(clean)) throw new Error('请输入 6 位房间码');
  session = { roomId: clean, name, token: null, playerId: null };
  saveSession();
  connect();
}

async function quickMatch(name) {
  const response = await fetch('/api/rooms/quickjoin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '快速加入失败');
  joinRoom(data.code, name);
  return data;
}

async function refreshPublicRooms() {
  if (!state && $('#lobbyEntry').hidden === false && $('#lobbyDialog').open) {
    try {
      const response = await fetch('/api/rooms', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const rooms = data.rooms || [];
      $('#publicRooms').hidden = rooms.length === 0;
      const list = $('#publicRoomList');
      list.replaceChildren();
      rooms.forEach((room) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'public-room-button';
        const code = document.createElement('strong');
        code.textContent = room.code;
        const detail = document.createElement('span');
        detail.textContent = `${room.count}/6 人 · ${room.host}的房间`;
        button.append(code, detail);
        button.addEventListener('click', () => {
          try {
            const name = playerName();
            localStorage.setItem('bossclub.name', name);
            joinRoom(room.code, name);
          } catch (error) {
            $('#lobbyError').textContent = error.message;
            $('#playerName').focus();
          }
        });
        list.append(button);
      });
    } catch {}
  }
}

function leaveRoom() {
  manualClose = true;
  clearTimeout(reconnectTimer);
  if (socket) socket.close();
  socket = null;
  connected = false;
  session = null;
  state = null;
  saveSession();
  $('#leaveButton').hidden = true;
  $('#roomCode').textContent = '#------';
  $('#roomName').textContent = '在线联机';
  setConnection('未连接');
  $('#endDialog').close();
  $('#discardDialog').close();
  $('#cardDialog').close();
  renderAll();
  showLobbyEntry();
}

function handlePhase() {
  if (!state) return;
  if (state.phase === 'lobby') {
    $('#endDialog').close();
    renderLobby();
    if (!$('#lobbyDialog').open) $('#lobbyDialog').showModal();
  } else {
    if ($('#lobbyDialog').open) $('#lobbyDialog').close();
  }
  if (state.phase === 'discard') renderDiscard();
  else if ($('#discardDialog').open) $('#discardDialog').close();
  if (state.phase === 'ended' && state.revision !== endShownRevision) {
    endShownRevision = state.revision;
    renderEnd();
    if (!$('#endDialog').open) $('#endDialog').showModal();
  } else if (state.phase !== 'ended' && $('#endDialog').open) {
    $('#endDialog').close();
  }
}

function renderAll() {
  renderHeader();
  renderSeats();
  renderDeal();
  renderAllocations();
  renderHand();
  renderEffects();
  renderMessages();
  renderControls();
  updateStopWindow();
}

function renderHeader() {
  $('#roomCode').textContent = state ? `#${state.code}` : '#------';
  $('#roomName').textContent = state ? '周末资本局' : '本地联机';
  document.title = state ? `#${state.code} · 我是大老板` : '我是大老板 · BOSS CLUB';
  $('#tableNote').textContent = state ? `服务端权威联机 · ${state.players.length}/6 人 · 房间 ${state.code}` : '服务端权威联机 · 3–6 人 · 同一电脑多开或局域网访问';
}

function renderSeats() {
  const container = $('#playerSeats');
  container.replaceChildren();
  if (!state?.players.length) return;
  state.players.forEach((player, index) => {
    const seat = document.createElement('article');
    seat.className = `player-seat pos-${index}${player.id === state.turnPlayerId && !state.ended ? ' is-active' : ''}${player.id === state.selfId ? ' is-self' : ''}${player.connected ? '' : ' is-offline'}`;
    seat.setAttribute('aria-label', `玩家${player.name}`);
    const avatar = document.createElement('div');
    avatar.className = `mini-avatar ${player.avatarClass}`;
    avatar.style.background = player.color;
    avatar.textContent = player.initial;
    const copy = document.createElement('div');
    copy.className = 'seat-copy';
    const name = document.createElement('strong');
    name.textContent = player.name;
    if (player.id === state.selfId) {
      const you = document.createElement('span');
      you.className = 'you-tag';
      you.textContent = '你';
      name.append(you);
    }
    const investors = document.createElement('small');
    investors.className = 'seat-investors';
    investors.textContent = player.investors.length ? player.investors.join(' · ') : '等待发牌';
    copy.append(name, investors);
    const cash = document.createElement('div');
    cash.className = 'cash';
    const cashLabel = document.createElement('small');
    cashLabel.textContent = player.connected ? '资金' : '离线';
    const cashValue = document.createElement('strong');
    cashValue.textContent = money(player.cash);
    cash.append(cashLabel, cashValue);
    seat.append(avatar, copy, cash);
    if (player.id === state.turnPlayerId && !state.ended) {
      const flag = document.createElement('span');
      flag.className = 'turn-flag';
      flag.textContent = player.id === state.selfId ? '你的回合' : '思考中';
      seat.append(flag);
    }
    container.append(seat);
  });
}

function renderDeal(animate = false) {
  const board = $('#board');
  board.classList.toggle('is-waiting', !state || state.phase === 'lobby');
  const rail = $('#dealRail');
  rail.replaceChildren();
  DEAL_TITLES.forEach((title, index) => {
    const done = state?.completed.includes(index);
    const current = state?.marker === index && !done;
    const step = document.createElement('span');
    step.className = `deal-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`;
    step.title = `第 ${index + 1} 笔：${title}`;
    const circle = document.createElement('i');
    if (done) circle.innerHTML = '<svg><use href="#icon-check"/></svg>';
    else circle.textContent = pad(index + 1);
    const label = document.createElement('small');
    label.textContent = done ? '成交' : pad(index + 1);
    step.append(circle, label);
    rail.append(step);
  });
  if (!state) return;
  const deal = state.currentDeal;
  $('#dealCounter').textContent = pad(Math.min(15, state.completed.length + 1));
  $('#dealNumber').textContent = `DEAL ${pad(state.marker + 1)}`;
  $('#dealSector').textContent = deal.sector;
  $('#dealEnglish').textContent = deal.english;
  $('#dealTitle').textContent = deal.title;
  $('#sharePrice').textContent = money(deal.price);
  $('#shareCount').textContent = deal.shares;
  $('#dealTotal').textContent = money(deal.total);
  $('#payoutTotal').textContent = money(deal.total);
  const required = $('#requiredInvestors');
  required.replaceChildren();
  deal.required.forEach((id) => {
    const investor = INVESTORS.find((item) => item.id === id);
    const owner = state.players.find((player) => player.investors.includes(id));
    const proxy = state.proxies[id];
    const chip = document.createElement('span');
    if (state.traveled.includes(id) && !proxy) chip.classList.add('is-unavailable');
    chip.title = proxy ? `${investor.name}由家族代理人支持` : owner ? `由${owner.name}控制` : '位于中央或暂时缺席';
    const letter = document.createElement('b');
    letter.textContent = id;
    chip.append(letter, document.createTextNode(investor.short));
    required.append(chip);
  });
  $('#marker').style.right = `${12 + (state.marker % 3) * 14}px`;
  $('#marker').style.top = `${50 + Math.floor(state.marker / 3) * 10}px`;
  if (animate) {
    $('#dealCard').style.animation = 'none';
    void $('#dealCard').offsetWidth;
    $('#dealCard').style.animation = '';
  }
}

function renderAllocations() {
  const list = $('#allocationList');
  list.replaceChildren();
  if (!state?.players.length) {
    $('#allocationStatus').textContent = '等待玩家加入';
    $('#allocationBar').replaceChildren();
    return;
  }
  const version = state.proposal?.version || 0;
  if (version !== lastProposalVersion) {
    draftAllocations = state.proposal ? { ...state.proposal.allocations } : Object.fromEntries(state.players.map((player) => [player.id, 0]));
    lastProposalVersion = version;
  }
  const editable = !!state.can.propose && !state.pendingStop;
  state.players.forEach((player) => {
    const row = document.createElement('div');
    row.className = 'allocation-row';
    const avatar = document.createElement('span');
    avatar.className = `mini-avatar ${player.avatarClass}`;
    avatar.style.background = player.color;
    avatar.textContent = player.initial;
    const name = document.createElement('div');
    name.className = 'allocation-name';
    const strong = document.createElement('strong');
    strong.textContent = `${player.name}${player.id === state.selfId ? '（你）' : ''}`;
    if (state.approvals.includes(player.id)) {
      const mark = document.createElement('span');
      mark.className = 'approval-mark';
      mark.textContent = '已同意';
      strong.append(mark);
    }
    const small = document.createElement('small');
    small.textContent = player.investors.length ? `${player.investors.join(' · ')} 投资者` : '等待发牌';
    name.append(strong, small);
    const inputWrap = document.createElement('label');
    inputWrap.className = 'money-input';
    const dollar = document.createElement('span');
    dollar.textContent = '$';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '100000';
    input.value = draftAllocations[player.id] || 0;
    input.disabled = !editable;
    input.title = money(draftAllocations[player.id] || 0);
    input.setAttribute('aria-label', `${player.name}的分配金额`);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      draftAllocations[player.id] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
      updateAllocationSummary();
    });
    inputWrap.append(dollar, input);
    row.append(avatar, name, inputWrap);
    list.append(row);
  });
  updateAllocationSummary();
}

function updateAllocationSummary() {
  if (!state) return;
  const total = Object.values(draftAllocations).reduce((sum, value) => sum + value, 0);
  const target = state.currentDeal.total;
  const status = $('#allocationStatus');
  if (state.phase === 'negotiation') {
    if (state.pendingStop) status.textContent = '等待叫停窗口结束';
    else if (!state.requirementsMet) status.textContent = '所需投资者缺席，需要代理人或招募';
    else if (!state.proposal) status.textContent = '老板提出方案后，所需投资者在此确认';
    else if (state.requiredApprovers.every((id) => state.approvals.includes(id))) status.textContent = '全部同意，可以宣布成交';
    else status.textContent = `等待 ${state.requiredApprovers.filter((id) => !state.approvals.includes(id)).length} 位投资者同意`;
  } else if (state.phase === 'turn') {
    status.textContent = state.turnPlayerId === state.selfId ? '轮到你：移动、抽牌或发起谈判' : '等待当前玩家行动';
  } else if (state.phase === 'discard') {
    status.textContent = `请弃掉 ${state.discardRequired} 张牌`;
  } else if (state.phase === 'ended') {
    status.textContent = '本局已结束';
  } else {
    status.textContent = '等待所有玩家准备';
  }
  const bar = $('#allocationBar');
  bar.replaceChildren();
  state.players.forEach((player) => {
    const segment = document.createElement('span');
    segment.style.width = `${target ? Math.min(100, (draftAllocations[player.id] || 0) / target * 100) : 0}%`;
    segment.style.background = player.color;
    bar.append(segment);
  });
  $('#proposeButton').disabled = !state.can.propose || total !== target;
}

function renderHand() {
  const hand = $('#handCards');
  hand.replaceChildren();
  const cards = state?.hand || [];
  cards.forEach((card) => {
    const type = CARD_TYPES[card.type];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `influence-card card-${card.type}`;
    const playable = !!state && (state.can.playCard || (card.type === 'stop' && state.can.stop));
    button.disabled = !playable;
    const investor = INVESTORS.find((item) => item.id === card.investor);
    const label = card.type === 'clan' ? `${investor?.short || ''}代理` : card.type === 'travel' && investor ? `${investor.short}旅行` : type.label;
    button.setAttribute('aria-label', `打出${label}`);
    button.innerHTML = `<span class="card-type">${type.code}</span><span class="card-corner">${type.symbol}</span><span class="card-symbol">${type.symbol}</span><span class="card-name">${label}</span>`;
    button.addEventListener('click', () => handleCardClick(card));
    hand.append(button);
  });
  $('#handCount').textContent = cards.length;
  $('#handHint').textContent = !state ? '加入房间并开始游戏后，你会收到 5 张私密手牌。' : state.phase === 'lobby' ? '等待房主开始游戏。' : state.pendingStop ? '旅行、招募或老板牌正在等待叫停。' : state.can.playCard ? '点击卡牌，在关键时刻打出。' : '谈判宣布后可以打出影响力牌。';
}

function renderEffects() {
  const stack = $('#effectStack');
  stack.replaceChildren();
  if (!state) return;
  Object.entries(state.proxies).forEach(([investor, playerId]) => {
    const owner = state.players.find((player) => player.id === playerId);
    const chip = document.createElement('span');
    chip.className = 'effect-chip';
    chip.textContent = `族：${investor} 由${owner?.name || '代理人'}代理`;
    stack.append(chip);
  });
  state.traveled.forEach((investor) => {
    const chip = document.createElement('span');
    chip.className = 'effect-chip';
    chip.textContent = `旅：${investor} 暂时退场`;
    stack.append(chip);
  });
}

function renderMessages() {
  const log = $('#chatLog');
  log.replaceChildren();
  const messages = state?.messages || [];
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = '谈判从一句闲聊开始。';
    log.append(empty);
  }
  messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `chat-message${message.playerId === state.selfId ? ' is-you' : ''}${message.system ? ' is-system' : ''}`;
    const name = document.createElement('strong');
    name.textContent = message.name;
    const text = document.createElement('p');
    text.textContent = message.text;
    item.append(name, text);
    log.append(item);
  });
  log.scrollTop = log.scrollHeight;
}

function renderControls() {
  const can = state?.can || {};
  $('#rollButton').disabled = !can.roll;
  $('#drawButton').disabled = !can.draw;
  $('#negotiateButton').disabled = !can.negotiate;
  $('#proposeButton').hidden = !can.propose;
  $('#approveButton').hidden = !can.approve;
  $('#confirmDealButton').hidden = !can.confirm;
  $('#cancelButton').hidden = !can.cancel;
  $('#endTurnButton').hidden = !can.endTurn;
  $('#splitButton').hidden = !can.propose;
  const labels = { lobby: '等待开局', turn: state?.turnPlayerId === state?.selfId ? '你的行动' : '等待行动', negotiation: '议价中', discard: '请弃牌', ended: '已结束' };
  $('#negotiationBadge').textContent = state ? labels[state.phase] : '等待开局';
  $('#chatInput').disabled = !state || state.phase === 'lobby';
  $('#chatForm button').disabled = !state || state.phase === 'lobby';
  updateAllocationSummary();
}

function renderLobby() {
  if (!state || state.phase !== 'lobby') return;
  $('#lobbyEntry').hidden = true;
  $('#roomWaiting').hidden = false;
  $('#waitingRoomCode').textContent = state.code;
  $('#waitingCount').textContent = `${state.players.length} / 6 人`;
  $('#poolInfo').textContent = state.players.length === 3 ? '3 人局：每人 2 张投资者牌' : state.players.length < 6 ? `中央余牌：${6 - state.players.length} 张` : '6 人局：每人 1 张投资者牌';
  const list = $('#lobbyPlayers');
  list.replaceChildren();
  state.players.forEach((player, index) => {
    const row = document.createElement('div');
    row.className = 'lobby-player';
    const avatar = document.createElement('span');
    avatar.className = `mini-avatar ${player.avatarClass}`;
    avatar.style.background = player.color;
    avatar.textContent = player.initial;
    const name = document.createElement('div');
    name.className = 'lobby-player-name';
    const strong = document.createElement('strong');
    strong.textContent = `${player.name}${player.id === state.selfId ? '（你）' : ''}`;
    const small = document.createElement('small');
    small.textContent = `${index + 1} 号座${player.id === state.hostId ? ' · 房主' : ''}${player.connected ? '' : ' · 离线'}`;
    name.append(strong, small);
    const ready = document.createElement('span');
    ready.className = `ready-state${player.ready ? ' is-ready' : ''}`;
    ready.textContent = player.ready ? '已准备' : '未准备';
    row.append(avatar, name, ready);
    list.append(row);
  });
  const me = state.players.find((player) => player.id === state.selfId);
  $('#readyButton').textContent = me?.ready ? '取消准备' : '我准备好了';
  $('#readyButton').disabled = !state.can.ready;
  $('#startButton').disabled = !state.can.start;
  $('#waitingError').textContent = '';
}

function showLobbyEntry(error = '') {
  state = null;
  $('#lobbyEntry').hidden = false;
  $('#roomWaiting').hidden = true;
  $('#lobbyError').textContent = error;
  if (!$('#lobbyDialog').open) $('#lobbyDialog').showModal();
  renderAll();
  refreshPublicRooms();
}

function handleCardClick(card) {
  if (!state) return;
  if (card.type === 'stop') {
    send('playCard', { cardId: card.id });
  } else if (card.type === 'travel') {
    openTravelDialog(card);
  } else if (card.type === 'recruit') {
    openRecruitDialog();
  } else {
    send('playCard', { cardId: card.id });
  }
}

function openTravelDialog(card) {
  $('#cardDialogTitle').textContent = `打出${CARD_TYPES.travel.label}`;
  const content = $('#cardDialogContent');
  content.replaceChildren();
  const hint = document.createElement('p');
  hint.className = 'dialog-hint';
  hint.textContent = '选择要暂时移出谈判的投资者；家族代理人会成为旅行目标。';
  const targets = document.createElement('div');
  targets.className = 'card-targets';
  INVESTORS.forEach((investor) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'target-button';
    button.disabled = !!card.investor && card.investor !== investor.id;
    const letter = document.createElement('b');
    letter.textContent = investor.id;
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = investor.name;
    const owner = state.players.find((player) => player.investors.includes(investor.id));
    const proxy = state.proxies[investor.id];
    const small = document.createElement('small');
    small.textContent = proxy ? '当前有家族代理人' : owner ? `由${owner.name}控制` : state.pool.includes(investor.id) ? '位于中央' : '暂不可用';
    copy.append(name, small);
    button.append(letter, copy);
    button.addEventListener('click', () => {
      send('playCard', { cardId: card.id, investor: investor.id });
      $('#cardDialog').close();
    });
    targets.append(button);
  });
  content.append(hint, targets);
  $('#cardDialog').showModal();
}

function openRecruitDialog() {
  recruitSelection = new Set();
  $('#cardDialogTitle').textContent = '三张招募令';
  const content = $('#cardDialogContent');
  content.replaceChildren();
  const hint = document.createElement('p');
  hint.className = 'dialog-hint';
  hint.textContent = '选择 3 张招募令和 1 位投资者，成功后可永久夺走投资者牌。';
  const cards = document.createElement('div');
  cards.className = 'recruit-select';
  const recruits = state.hand.filter((card) => card.type === 'recruit');
  if (!recruits.length) {
    const empty = document.createElement('p');
    empty.textContent = '你还没有招募令。';
    cards.append(empty);
  }
  recruits.forEach((card) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'influence-card card-recruit';
    button.innerHTML = '<span class="card-type">RECRUIT</span><span class="card-symbol">招</span><span class="card-name">招募令</span>';
    button.addEventListener('click', () => {
      if (recruitSelection.has(card.id)) recruitSelection.delete(card.id);
      else if (recruitSelection.size < 3) recruitSelection.add(card.id);
      button.classList.toggle('is-selected', recruitSelection.has(card.id));
      updateRecruitButton();
    });
    cards.append(button);
  });
  const selectLabel = document.createElement('label');
  selectLabel.className = 'field-label';
  selectLabel.textContent = '招募目标';
  const select = document.createElement('select');
  select.className = 'text-field';
  select.id = 'recruitTarget';
  const targets = INVESTORS.filter((investor) => state.pool.includes(investor.id) || state.players.some((player) => player.investors.includes(investor.id)));
  targets.forEach((investor) => {
    const owner = state.players.find((player) => player.investors.includes(investor.id));
    const option = document.createElement('option');
    option.value = investor.id;
    option.textContent = `${investor.id} · ${investor.name}${owner ? `（${owner.name}）` : '（中央）'}`;
    select.append(option);
  });
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'button button-primary recruit-confirm';
  confirm.textContent = '打出 3 张招募令';
  confirm.disabled = true;
  confirm.addEventListener('click', () => {
    send('playCard', { cardIds: [...recruitSelection], investor: select.value });
    $('#cardDialog').close();
  });
  function updateRecruitButton() {
    confirm.disabled = recruitSelection.size !== 3 || !select.value;
  }
  select.addEventListener('change', updateRecruitButton);
  content.append(hint, cards, selectLabel, select, confirm);
  $('#cardDialog').showModal();
}

function renderDiscard() {
  discardSelection = new Set();
  const cards = $('#discardCards');
  cards.replaceChildren();
  $('#discardHint').textContent = `手牌超过 12 张，请选择 ${state.discardRequired} 张弃牌。`;
  state.hand.forEach((card) => {
    const type = CARD_TYPES[card.type];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `influence-card card-${card.type}`;
    button.innerHTML = `<span class="card-type">${type.code}</span><span class="card-symbol">${type.symbol}</span><span class="card-name">${type.label}</span>`;
    button.addEventListener('click', () => {
      if (discardSelection.has(card.id)) discardSelection.delete(card.id);
      else if (discardSelection.size < state.discardRequired) discardSelection.add(card.id);
      button.classList.toggle('is-selected', discardSelection.has(card.id));
      $('#confirmDiscardButton').disabled = discardSelection.size !== state.discardRequired;
    });
    cards.append(button);
  });
  $('#confirmDiscardButton').disabled = true;
  if (!$('#discardDialog').open) $('#discardDialog').showModal();
}

function renderEnd() {
  const sorted = [...state.players].sort((a, b) => b.cash - a.cash);
  const winner = sorted[0];
  $('#endTitle').textContent = winner.id === state.selfId ? '你就是大老板！' : `${winner.name}成为大老板`;
  $('#endReason').textContent = state.endReason;
  const board = $('#leaderboard');
  board.replaceChildren();
  sorted.forEach((player, index) => {
    const row = document.createElement('div');
    row.className = `leader-row${index === 0 ? ' is-winner' : ''}`;
    const rank = document.createElement('span');
    rank.className = 'leader-rank';
    rank.textContent = pad(index + 1);
    const avatar = document.createElement('span');
    avatar.className = `mini-avatar ${player.avatarClass}`;
    avatar.textContent = player.initial;
    const name = document.createElement('span');
    name.className = 'leader-name';
    name.textContent = `${player.name}${player.id === state.selfId ? '（你）' : ''}${index === 0 ? ' · 大老板' : ''}`;
    const cash = document.createElement('strong');
    cash.className = 'leader-cash';
    cash.textContent = money(player.cash);
    row.append(rank, avatar, name, cash);
    board.append(row);
  });
  $('#playAgainButton').hidden = !state.can.restart;
  $('#playAgainButton').textContent = state.can.restart ? '重新开局' : '等待房主重开';
  const confetti = $('#confetti');
  confetti.replaceChildren();
  const colors = ['#e7773e', '#f3c969', '#6e9b6c', '#6c9cae', '#d88f94'];
  for (let index = 0; index < 22; index += 1) {
    const piece = document.createElement('i');
    piece.style.left = `${(index * 37) % 100}%`;
    piece.style.background = colors[index % colors.length];
    piece.style.animationDelay = `${(index % 7) * .18}s`;
    confetti.append(piece);
  }
}

function updateStopWindow() {
  const panel = $('#stopWindow');
  if (!state?.pendingStop) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const remaining = Math.max(0, Math.ceil((state.pendingStop.expiresAt - Date.now()) / 1000));
  $('#stopCountdown').textContent = `${state.pendingStop.actorName}的${state.pendingStop.kind === 'boss' ? '老板卡' : state.pendingStop.kind === 'recruit' ? '招募' : '旅行令'} · ${remaining}秒`;
  const stopCard = state.hand.find((card) => card.type === 'stop');
  $('#quickStopButton').hidden = !state.can.stop || !stopCard;
}

function playerName() {
  const name = $('#playerName').value.trim();
  if (!name) throw new Error('请先填写昵称');
  return name.slice(0, 12);
}

$('#createRoomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const name = playerName();
    localStorage.setItem('bossclub.name', name);
    await createRoom(name);
  } catch (error) {
    $('#lobbyError').textContent = error.message;
  }
});

$('#joinRoomForm').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const name = playerName();
    localStorage.setItem('bossclub.name', name);
    joinRoom($('#roomInput').value, name);
  } catch (error) {
    $('#lobbyError').textContent = error.message;
  }
});

$('#quickMatchButton').addEventListener('click', async () => {
  try {
    const name = playerName();
    localStorage.setItem('bossclub.name', name);
    $('#quickMatchButton').disabled = true;
    await quickMatch(name);
  } catch (error) {
    $('#lobbyError').textContent = error.message;
  } finally {
    $('#quickMatchButton').disabled = false;
  }
});

$('#readyButton').addEventListener('click', () => send('ready'));
$('#startButton').addEventListener('click', () => send('start'));
$('#rollButton').addEventListener('click', () => send('roll'));
$('#drawButton').addEventListener('click', () => send('draw'));
$('#negotiateButton').addEventListener('click', () => send('negotiate'));
$('#endTurnButton').addEventListener('click', () => send('endTurn'));
$('#cancelButton').addEventListener('click', () => send('cancel'));
$('#approveButton').addEventListener('click', () => send('approve'));
$('#confirmDealButton').addEventListener('click', () => send('confirm'));
$('#proposeButton').addEventListener('click', () => send('propose', { allocations: draftAllocations }));
$('#splitButton').addEventListener('click', () => {
  if (!state) return;
  const base = Math.floor(state.currentDeal.total / state.players.length);
  draftAllocations = Object.fromEntries(state.players.map((player) => [player.id, base]));
  draftAllocations[state.players[0].id] += state.currentDeal.total - base * state.players.length;
  renderAllocations();
});
$('#confirmDiscardButton').addEventListener('click', () => send('discard', { cardIds: [...discardSelection] }));
$('#quickStopButton').addEventListener('click', () => {
  const card = state?.hand.find((item) => item.type === 'stop');
  if (card) send('playCard', { cardId: card.id });
});
$('#playAgainButton').addEventListener('click', () => send('restart'));
$('#leaveButton').addEventListener('click', leaveRoom);
document.querySelectorAll('[data-leave]').forEach((button) => button.addEventListener('click', leaveRoom));
$('#rulesButton').addEventListener('click', () => $('#rulesDialog').showModal());
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#rulesDialog').addEventListener('click', (event) => { if (event.target === $('#rulesDialog')) $('#rulesDialog').close(); });
$('#lobbyDialog').addEventListener('cancel', (event) => event.preventDefault());
$('#copyInviteButton').addEventListener('click', async () => {
  if (!state) return;
  const url = `${location.origin}/?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('邀请链接已复制');
  } catch {
    showToast(`邀请链接：${url}`);
  }
});

$('#chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !send('chat', { text })) return;
  input.value = '';
});

window.addEventListener('online', () => { if (session && !connected) connect(); });
window.addEventListener('offline', () => showToast('网络已断开，正在等待重连', true));
setInterval(updateStopWindow, 250);
setInterval(refreshPublicRooms, 5000);

const savedName = localStorage.getItem('bossclub.name');
if (savedName) $('#playerName').value = savedName;
const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl) $('#roomInput').value = roomFromUrl.toUpperCase();
fetch('/api/health').then((response) => response.json()).then((health) => {
  const lan = health.lanUrls?.find((url) => !url.includes('169.254.'));
  if (lan) $('#tableNote').textContent = `局域网访问：${lan} · 3–6 人`;
}).catch(() => {});

renderAll();
if (session) connect();
else showLobbyEntry();
