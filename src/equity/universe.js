// Вселенная тикеров для сканера + курируемая карта пиров для страницы анализа
// (спека 06 §6.2 / 02 §2.6). Вселенная — статический курируемый список (11
// корзин по секторам yfinance), обновляется вручную; Russell-снимок не ведём.
// Корзина — только стартовый набор: секторная фильтрация всегда по фактическому
// info.sector из Yahoo, так что спорные классификации не ломают скан.

// корзина → значение yfinance info.sector
const SECTOR_OF_BASKET = {
  technology: 'Technology',
  healthcare: 'Healthcare',
  financials: 'Financial Services',
  consumer_discretionary: 'Consumer Cyclical',
  consumer_staples: 'Consumer Defensive',
  industrials: 'Industrials',
  energy: 'Energy',
  materials: 'Basic Materials',
  utilities: 'Utilities',
  real_estate: 'Real Estate',
  communication_services: 'Communication Services',
};

const BASKETS = {
  technology: [
    'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'AMD', 'QCOM', 'TXN',
    'INTC', 'AMAT', 'MU', 'LRCX', 'ADI', 'KLAC', 'SNPS', 'CDNS', 'ANET', 'DELL',
    'HPQ', 'SMCI', 'CSCO', 'PANW', 'CRWD', 'SNOW', 'NET', 'DDOG', 'ZS', 'OKTA',
    'WDAY', 'SHOP', 'VEEV', 'HUBS', 'ZM', 'DOCU', 'TWLO', 'ABNB', 'MDB', 'TEAM',
    'PYPL', 'COIN', 'HOOD', 'UBER', 'TTD', 'ROKU', 'RBLX', 'U', 'DKNG', 'APP',
    'AKAM', 'FFIV', 'CHKP', 'WIX', 'MRVL', 'FTNT', 'INTU', 'ADSK', 'PTC', 'TYL',
    'QRVO', 'SWKS', 'MPWR', 'ON', 'NXPI', 'TER', 'ENTG', 'WDC', 'STX',
  ],
  healthcare: [
    'LLY', 'JNJ', 'UNH', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'AMGN',
    'ISRG', 'BMY', 'GILD', 'VRTX', 'REGN', 'MRNA', 'BNTX', 'BIIB', 'ALNY', 'INCY',
    'NBIX', 'SRPT', 'CRSP', 'NTRA', 'WAT', 'A', 'CRL', 'IQV', 'MTD', 'DXCM',
    'PODD', 'TNDM', 'IRTC', 'BEAM', 'NTLA', 'RXRX', 'HOLX', 'EXAS', 'GH', 'IDXX',
    'ZTS', 'ELAN', 'TEVA', 'VTRS', 'CVS', 'CI', 'ELV', 'NVO', 'AZN', 'SGEN',
    'PTCT', 'RARE', 'ARGX', 'BMRN', 'IONS', 'XRAY', 'MCK',
  ],
  financials: [
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'BLK', 'BX', 'KKR',
    'APO', 'ARES', 'OWL', 'COF', 'USB', 'PNC', 'TFC', 'FITB', 'MTB', 'HBAN',
    'KEY', 'RF', 'CFG', 'STT', 'BK', 'ICE', 'CME', 'NDAQ', 'CBOE', 'MKTX',
    'MCO', 'SPGI', 'MSCI', 'FDS', 'AJG', 'AON', 'MMC', 'WTW', 'PGR', 'ALL',
    'TRV', 'HIG', 'CINF', 'CB', 'WRB', 'AIZ', 'MET', 'PRU', 'AFL', 'GL',
    'PFG', 'BRK-B', 'RY', 'TD',
  ],
  consumer_discretionary: [
    'AMZN', 'TSLA', 'HD', 'LOW', 'TJX', 'ROST', 'BURL', 'DG', 'DLTR', 'ORLY',
    'AZO', 'AAP', 'ULTA', 'LULU', 'NKE', 'DECK', 'ONON', 'SKX', 'CROX', 'GPS',
    'ANF', 'YUM', 'QSR', 'CMG', 'MCD', 'SBUX', 'DPZ', 'YUMC', 'WING', 'DRI',
    'MAR', 'HLT', 'H', 'IHG', 'WH', 'RCL', 'CCL', 'NCLH', 'UAL', 'DAL',
    'AAL', 'LUV', 'ALK', 'F', 'GM', 'STLA', 'RIVN', 'LCID', 'NIO', 'XPEV',
    'EBAY', 'ETSY', 'W', 'CHWY', 'RH', 'WSM', 'FND', 'DKS', 'ASO', 'BBY',
    'FIVE', 'OLLI', 'MAT', 'HAS', 'RL', 'COH', 'TPR', 'CPRI', 'SHOO', 'YETI',
  ],
  consumer_staples: [
    'PG', 'KO', 'PEP', 'COST', 'WMT', 'TGT', 'KR', 'ACI', 'SYY', 'GIS',
    'K', 'KHC', 'CPB', 'CAG', 'HRL', 'SJM', 'TSN', 'PPC', 'MDLZ', 'HSY',
    'MKC', 'KMB', 'CL', 'CHD', 'CLX', 'EL', 'STZ', 'TAP', 'BTI', 'MO',
    'PM', 'UVV', 'ADM', 'BG', 'KOF', 'ELF', 'MNST', 'COTY', 'POST', 'THS',
  ],
  industrials: [
    'CAT', 'DE', 'CNH', 'AGCO', 'ITW', 'PH', 'ETN', 'EMR', 'ROP', 'TDG',
    'LMT', 'RTX', 'NOC', 'GD', 'LHX', 'TXT', 'HWM', 'BA', 'GE', 'GEV',
    'TT', 'CARR', 'LII', 'DOV', 'IEX', 'ITT', 'GGG', 'FAST', 'GWW', 'WSO',
    'PWR', 'EME', 'FIX', 'MTZ', 'BLDR', 'URI', 'WAB', 'ODFL', 'SAIA', 'XPO',
    'CHRW', 'FDX', 'UPS', 'GXO', 'UNP', 'CSX', 'NSC', 'LDOS', 'BAH', 'CACI',
    'AVAV', 'KTOS', 'RKLB', 'CW', 'HII', 'AME', 'ATKR', 'ESAB', 'AAON',
  ],
  energy: [
    'XOM', 'CVX', 'COP', 'EOG', 'OXY', 'HES', 'DVN', 'FANG', 'APA', 'CTRA',
    'PSX', 'VLO', 'MPC', 'DK', 'WMB', 'KMI', 'OKE', 'ET', 'EPD', 'PAA',
    'ENB', 'TRP', 'LNG', 'CQP', 'SLB', 'BKR', 'HAL', 'NOV', 'FTI', 'RIG',
    'VAL', 'PTEN', 'EQT', 'AR', 'CRK', 'CVE', 'SU', 'IMO', 'PBR', 'TPL',
  ],
  materials: [
    'LIN', 'APD', 'SHW', 'PPG', 'RPM', 'AXTA', 'ECL', 'DD', 'DOW', 'LYB',
    'WLK', 'EMN', 'CE', 'HUN', 'OLN', 'ASH', 'NEU', 'MOS', 'NTR', 'CF',
    'IPI', 'SMG', 'IP', 'GP', 'PKG', 'SEE', 'VMC', 'MLM', 'CX', 'FCX',
    'TECK', 'SCCO', 'RIO', 'BHP', 'AEM', 'GOLD', 'NEM', 'KGC', 'PAAS', 'AG',
    'MP', 'ALB', 'FMC', 'CTVA',
  ],
  utilities: [
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL', 'ED', 'EIX',
    'PCG', 'WEC', 'ES', 'DTE', 'AEE', 'CMS', 'PPL', 'NI', 'ATO', 'AWK',
    'WTRG', 'VST', 'CEG', 'NRG', 'TLN', 'OGE', 'IDA', 'POR', 'LNT', 'EVRG',
    'CNP', 'PNW',
  ],
  real_estate: [
    'PLD', 'AMT', 'CCI', 'EQIX', 'DLR', 'SPG', 'O', 'WPC', 'PSA', 'EXR',
    'CUBE', 'AVB', 'EQR', 'ESS', 'MAA', 'UDR', 'CPT', 'IRM', 'VICI', 'INVH',
    'AMH', 'ELS', 'SUI', 'ARE', 'BXP', 'KIM', 'REG', 'FRT', 'BRX', 'DOC',
    'MPW', 'HST', 'RHP',
  ],
  communication_services: [
    'GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'TMUS', 'VZ', 'CHTR',
    'WBD', 'FOXA', 'FOX', 'NWSA', 'LYV', 'TTWO', 'EA', 'SPOT', 'PINS', 'SNAP',
    'RDDT', 'MTCH', 'BMBL', 'TU', 'BCE', 'SIRI', 'OMC', 'IPG', 'TTGT',
  ],
};

// БРКБ в yahoo-нотации — BRK-B; нормализуем варианты написания
function normTicker(t) {
  const T = String(t || '').toUpperCase().trim();
  if (T === 'BRK.B' || T === 'BRKB' || T === 'BRK_B') return 'BRK-B';
  return T;
}

// плоский список вселенной (sector = значение yfinance info.sector; null → все)
function universe(sector) {
  if (!sector) return Object.values(BASKETS).flat().map(normTicker);
  const basket = Object.keys(SECTOR_OF_BASKET).find(b => SECTOR_OF_BASKET[b] === sector);
  return (BASKETS[basket] || []).map(normTicker);
}

const SECTORS = Object.values(SECTOR_OF_BASKET);

// ── Курируемая карта пиров (спека 02 §2.6): большие имена, 2–4 пира.
// Фоллбек (когда тикера нет) — 4 ближайших по капитализации из корзины сектора.
const PEERS_MAP = {
  AAPL: ['MSFT', 'DELL', 'GOOGL'],
  MSFT: ['AAPL', 'ORCL', 'GOOGL', 'CRM'],
  NVDA: ['AMD', 'INTC', 'AVGO', 'QCOM'],
  AMD: ['NVDA', 'INTC', 'MRVL', 'QCOM'],
  GOOGL: ['META', 'MSFT', 'AMZN'],
  META: ['GOOGL', 'SNAP', 'PINS', 'MTCH'],
  AMZN: ['WMT', 'EBAY', 'SHOP'],
  TSLA: ['GM', 'F', 'RIVN'],
  NFLX: ['DIS', 'CMCSA', 'WBD'],
  DIS: ['NFLX', 'CMCSA', 'WBD', 'SIRI'],
  JPM: ['BAC', 'WFC', 'C', 'GS'],
  GS: ['MS', 'JPM', 'SCHW', 'BLK'],
  MS: ['GS', 'JPM', 'C', 'BAC'],
  BLK: ['BX', 'KKR', 'APO'],
  SCHW: ['MS', 'JPM', 'AMTD'],
  LLY: ['NVO', 'PFE', 'MRK', 'AZN'],
  UNH: ['ELV', 'CI', 'CVS', 'HUM'],
  MRK: ['PFE', 'LLY', 'BMY', 'AZN'],
  PFE: ['MRK', 'LLY', 'BMY', 'AZN'],
  TMO: ['A', 'DHR', 'WAT', 'CRL'],
  ISRG: ['ABT', 'MDT', 'SYK', 'BSX'],
  XOM: ['CVX', 'COP', 'SHEL', 'BP'],
  CVX: ['XOM', 'COP', 'OXY', 'HES'],
  WMT: ['COST', 'TGT', 'DG', 'KR'],
  COST: ['WMT', 'TGT', 'KR', 'BJ'],
  KO: ['PEP', 'MNST', 'KOF', 'CAG'],
  PEP: ['KO', 'MNST', 'KDP', 'CAG'],
  MCD: ['SBUX', 'YUM', 'QSR', 'WEN'],
  SBUX: ['MCD', 'YUM', 'QSR', 'DRI'],
  NKE: ['DECK', 'ONON', 'SKX', 'CROX'],
  CAT: ['DE', 'CNH', 'AGCO', 'PH'],
  DE: ['CAT', 'CNH', 'AGCO', 'ITW'],
  BA: ['LMT', 'RTX', 'GD'],
  UNP: ['CSX', 'NSC', 'ODFL', 'CHRW'],
  PLD: ['PSA', 'EXR', 'CUBE', 'ARE'],
  AMT: ['CCI', 'SBAC', 'EQIX', 'DLR'],
  SPG: ['O', 'WPC', 'REG', 'FRT'],
  LIN: ['APD', 'SHW', 'ECL', 'PX'],
  SHW: ['PPG', 'RPM', 'AXTA', 'ECL'],
  NEE: ['DUK', 'SO', 'D', 'AEP'],
  ORCL: ['MSFT', 'CRM', 'SAP', 'NOW'],
  CRM: ['MSFT', 'ORCL', 'NOW', 'WDAY'],
  ADBE: ['MSFT', 'CRM', 'PANW', 'INTU'],
  AVGO: ['NVDA', 'QCOM', 'TXN', 'MRVL'],
  QCOM: ['NVDA', 'AVGO', 'TXN', 'MRVL'],
  TXN: ['ADI', 'NXPI', 'MCHP', 'AVGO'],
  INTC: ['NVDA', 'AMD', 'QCOM', 'TXN'],
  ABBV: ['MRK', 'PFE', 'BMY', 'GILD'],
  AMGN: ['GILD', 'BIIB', 'REGN', 'BMRN'],
  GILD: ['AMGN', 'BIIB', 'MRK', 'VRTX'],
  VRTX: ['REGN', 'MRNA', 'BNTX', 'ALNY'],
  CMCSA: ['DIS', 'NFLX', 'WBD', 'T'],
  VZ: ['T', 'TMUS', 'CMCSA', 'CHTR'],
  T: ['VZ', 'TMUS', 'TU', 'BCE'],
  FDX: ['UPS', 'XPO', 'ODFL', 'CHRW'],
  GM: ['F', 'TSLA', 'STLA', 'RIVN'],
  F: ['GM', 'TSLA', 'STLA', 'RIVN'],
  GE: ['RTX', 'HON', 'ETN', 'LMT'],
  RTX: ['BA', 'LMT', 'GD', 'NOC'],
  LMT: ['RTX', 'NOC', 'GD', 'BA'],
  PGR: ['ALL', 'TRV', 'CB', 'HIG'],
  COP: ['XOM', 'CVX', 'OXY', 'EOG'],
  EOG: ['COP', 'DVN', 'APA', 'FANG'],
  MPC: ['VLO', 'PSX', 'DK', 'PBF'],
};

module.exports = { BASKETS, SECTOR_OF_BASKET, SECTORS, universe, PEERS_MAP, normTicker };
