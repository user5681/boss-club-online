export const INVESTORS = [
  { id: 'A', name: '莱恩家族', short: '莱恩', color: '#e7773e', avatarClass: 'avatar-orange' },
  { id: 'B', name: '莫里斯家族', short: '莫里斯', color: '#d88f94', avatarClass: 'avatar-pink' },
  { id: 'C', name: '欧阳家族', short: '欧阳', color: '#6e9b6c', avatarClass: 'avatar-green' },
  { id: 'D', name: '苏菲家族', short: '苏菲', color: '#6c9cae', avatarClass: 'avatar-blue' },
  { id: 'E', name: '塔克家族', short: '塔克', color: '#b49bc8', avatarClass: 'avatar-purple' },
  { id: 'F', name: '王氏家族', short: '王氏', color: '#c6a35d', avatarClass: 'avatar-gold' },
];

export const CARD_TYPES = {
  clan: { label: '家族代理人', symbol: '族', code: 'CLAN' },
  travel: { label: '旅行令', symbol: '旅', code: 'TRAVEL' },
  recruit: { label: '招募令', symbol: '招', code: 'RECRUIT' },
  stop: { label: '叫停卡', symbol: '停', code: 'STOP' },
  boss: { label: '老板卡', symbol: '主', code: 'BOSS' },
};

const titles = [
  ['云端新城计划', 'CLOUD CITY', '城市发展', 3, ['A', 'C']],
  ['海岸快线', 'COASTAL EXPRESS', '交通运输', 4, ['B', 'D']],
  ['星光酒店集团', 'STARLIGHT HOTELS', '酒店餐饮', 2, ['A', 'D']],
  ['绿洲能源', 'OASIS ENERGY', '清洁能源', 3, ['B', 'C']],
  ['城市光影院线', 'CITY CINEMA', '文化娱乐', 4, ['C', 'D']],
  ['远洋航运', 'OCEAN LINE', '交通运输', 3, ['A', 'B']],
  ['未来制造工厂', 'FUTURE WORKS', '智能制造', 2, ['B', 'D']],
  ['中央商业中心', 'CENTRAL MALL', '商业地产', 4, ['A', 'C']],
  ['云端数据', 'CLOUD DATA', '数字科技', 3, ['B', 'C']],
  ['度假群岛', 'HOLIDAY ISLES', '休闲旅游', 2, ['C', 'D']],
  ['城市电车', 'CITY TRAM', '公共交通', 3, ['A', 'B']],
  ['奇想主题乐园', 'WONDER PARK', '文化娱乐', 3, ['A', 'D']],
  ['星际太空港', 'ORBIT PORT', '航天科技', 2, ['B', 'C']],
  ['国际会展中心', 'WORLD EXPO', '会展服务', 3, ['A', 'C', 'D']],
  ['世界之巅', 'THE SUMMIT', '压轴交易', 3, ['A', 'B', 'C', 'D']],
];

export const DEALS = titles.map(([title, english, sector, shares, required], index) => ({
  id: index + 1,
  title,
  english,
  sector,
  shares,
  required,
  price: index < 3 ? 2_000_000 : index < 6 ? 3_000_000 : index < 9 ? 4_000_000 : 5_000_000,
}));

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function buildDeck(random = Math.random) {
  const cards = [];
  const add = (type, count, investor = null) => {
    for (let index = 0; index < count; index += 1) {
      cards.push({ id: `${type}-${investor || 'wild'}-${index + 1}`, type, investor });
    }
  };
  INVESTORS.forEach((investor) => {
    add('clan', 4, investor.id);
    add('travel', 3, investor.id);
  });
  add('travel', 3);
  add('recruit', 33);
  add('boss', 10);
  add('stop', 10);
  return shuffle(cards, random);
}

export function dealPayout(deal) {
  return deal.price * deal.shares;
}
