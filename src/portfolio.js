// ─────────────────────────────────────────────────────────────
// ПОЗИЦИИ приходят напрямую из Tradernet API (src/tradernet.js):
// тикер/кол-во/цена входа — всегда актуальные на момент запроса.
// Здесь только мета: tag, уровни докупа lv = [T1,T2,T3]
// (null = не докупать) и заметки.
// tag: core | real | quality | lotto | exit | index
// ─────────────────────────────────────────────────────────────
const { getPositions, posSource } = require('./tradernet');

const META = {
  // AI-ядро
  TSM:   { tag:'core',    lv:[380,355,340],    note:'лучшее качество/цена в AI' },
  AVGO:  { tag:'core',    lv:[null,370,300],   note:'T3 — последний транш' },
  CEG:   { tag:'core',    lv:[null,230,205],   note:'AI-энергия' },
  NOW:   { tag:'core',    lv:[null,92,80],     note:'дорогой SaaS' },
  NVDA:  { tag:'core',    lv:[null,null,null], note:'дёшево ~16x fwd, но квота' },
  MRVL:  { tag:'core',    lv:[null,200,170],   note:'не догоняться' },
  INTU:  { tag:'core',    lv:[null,null,null], note:'вне плана' },
  META:  { tag:'core',    lv:[null,null,null], note:'FCF схлопнулся — не добирать' },

  // Реальные активы
  CCJ:   { tag:'real',    lv:[92,85,78],       note:'уран, контрактный цикл' },
  BWXT:  { tag:'real',    lv:[170,153,135],    note:'дорого, ждать откат' },
  NTR:   { tag:'real',    lv:[70,62,53],       note:'DCA' },
  CF:    { tag:'real',    lv:[115,102,90],     note:'' },
  MOS:   { tag:'real',    lv:[22,19,17],       note:'' },
  SHEL:  { tag:'real',    lv:[86,78,69],       note:'DCA' },
  NEM:   { tag:'real',    lv:[100,88,78],      note:'золото/фиск. хедж' },
  GAU:   { tag:'real',    lv:[null,null,null], note:'мелкое золото' },
  UUUU:  { tag:'real',    lv:[null,null,null], note:'микро-сателлит' },
  HGBL:  { tag:'real',    lv:[null,null,null], note:'контрциклик, потолок 1,5%' },

  // Quality-компаундеры
  TDG:   { tag:'quality', lv:[null,null,null], note:'у потолка по имени' },
  VRSK:  { tag:'quality', lv:[185,165,148],    note:'ROIC 24%, маржа 46%' },
  ACIW:  { tag:'quality', lv:[null,null,null], note:'' },
  SIEGY: { tag:'quality', lv:[null,null,null], note:'' },
  ALSN:  { tag:'quality', lv:[null,null,null], note:'' },
  IRMD:  { tag:'quality', lv:[95,84,74],       note:'2-й транш после Q3' },
  GILD:  { tag:'quality', lv:[128,115,102],    note:'DCA, защита' },
  BMY:   { tag:'quality', lv:[null,null,null], note:'' },

  // Тезис повреждён — НЕ ДОБИРАТЬ
  PSN:   { tag:'quality', lv:null, note:'⛔ гайд срезан дважды' },
  ZTS:   { tag:'quality', lv:null, note:'⛔ эрозия ценовой власти' },
  NVO:   { tag:'quality', lv:null, note:'⛔ прогноз вниз, Lilly впереди' },
  LEGN:  { tag:'lotto',   lv:null, note:'⛔ J&J двигает конкурента' },

  // Биотех-лотереи
  CMPS:  { tag:'lotto', lv:null, note:'фикс половины на силе' },
  GHRS:  { tag:'lotto', lv:null, note:'фикс половины' },
  ATAI:  { tag:'lotto', lv:null, note:'фикс половины' },
  DFTX:  { tag:'lotto', lv:null, note:'фикс 1/2–2/3' },
  MRKR:  { tag:'lotto', lv:null, note:'риск разводнения' },

  // Прочее
  GDDY:  { tag:'quality', lv:null, note:'решить: держать или чистить' },
  AYTU:  { tag:'exit', lv:null, note:'продать' },
  VTI:   { tag:'index', lv:null, note:'не доливать — брать ITOT' },
};

// плановая строка: ежемесячный DCA в ITOT (позиции в API нет)
const ITOT = { t:'ITOT', qty:0, avg:0, lv:[999,999,999], tag:'index', note:'★ ежемесячный DCA' };

async function positions() {
  const list = (await getPositions())
    .map(p => ({ ...p, ...(META[p.t] || { tag:'quality', lv:null, note:'' }) }));
  list.push(ITOT);
  return list;
}

const WATCH = [
  { t:'INCY', note:'качество+рост, обрыв Jakafi 2028' },
  { t:'ISRG', note:'не-AI диверсификатор, зона $430–470', lv:[470,450,430] },
  { t:'AMAT', note:'32x fwd, циклик' },
  { t:'MKSI', note:'21x fwd, $1,4 млрд конвертов' },
];

const CASH = 1000;

module.exports = { positions, posSource, META, WATCH, CASH };
