'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { PROMPTS } = require('../src/prompts');

test('PROMPTS: все системные сообщения требуют JSON', () => {
  for (const name of ['detector', 'falsifyGenerate', 'falsifyCheck', 'committee', 'baserates', 'levelsDerive', 'thesisReview', 'buyCheck']) {
    const p = PROMPTS[name];
    assert.ok(p && typeof p.system === 'string' && p.system.length > 20, name + ': system есть');
    assert.ok(/JSON/i.test(p.system), name + ': system требует JSON');
    assert.strictEqual(typeof p.user, 'function', name + ': user — функция с данными');
  }
});

test('detector.user: тикер, σ, новости, филлинги и инструкция вердикта', () => {
  const s = PROMPTS.detector.user({
    t: 'PSN', meta: { tag: 'quality', note: 'гайденс срезан дважды' },
    thesis: { state: 'damaged', pillars: ['рост выручки'], damaged_pillars: ['рост выручки'], recovery_conditions: ['стабилизация'] },
    flag: { lastSigma: -4.2, cumSigma: -5.1 },
    news: [{ title: 'Guidance cut again', date: 1755800000000 }],
    filings: [{ form: '8-K', date: '2026-08-20', url: 'https://sec/xy' }],
  });
  assert.ok(s.includes('PSN'));
  assert.ok(s.includes('-4.2σ') && s.includes('-5.1σ'), 'σ аномалий: ' + s.match(/аномалия дня[^\n]*/));
  assert.ok(s.includes('Guidance cut again'));
  assert.ok(s.includes('8-K от 2026-08-20'));
  assert.ok(s.includes('thesis_damage'));
  assert.ok(s.includes('Состояние тезиса: damaged'), 'состояние машины на входе');
  assert.ok(s.includes('proposed_state'), 'предлагаемое состояние на выходе');
  // пустые данные — вежливые заглушки, не «undefined»
  const empty = PROMPTS.detector.user({ t: 'X', meta: {}, flag: {}, news: [], filings: [] });
  assert.ok(!empty.includes('undefined'), 'нет undefined при пустых данных');
  assert.ok(empty.includes('Новостей нет') && empty.includes('Филлингов нет'));
});

test('falsifyGenerate.user: тикер, тег, цена, уровни, until; ровно 3 условия', () => {
  const s = PROMPTS.falsifyGenerate.user({
    T: 'TSM', meta: { tag: 'core', note: 'AI-фабрика', lv: [380, 355, 340], until: { event: 'Q3', check: 'маржа' } },
    px: 412.5, news: [], filings: [],
  });
  assert.ok(s.includes('TSM') && s.includes('412.50') && s.includes('[380,355,340]'));
  assert.ok(s.includes('Q3'), 'until-событие в промпте');
  assert.ok(s.includes('ТРИ условия'));
  assert.ok(s.includes('"thesis"'));
});

test('falsifyCheck.user: тезис, состояние, нумерованные условия, запрет выдумывать факты', () => {
  const s = PROMPTS.falsifyCheck.user({
    T: 'CEG', thesis: 'AI-энергетика', state: 'watch', meta: { lv: [100, 90, 80] }, px: 95,
    conditions: [{ text: 'рост <10% два квартала' }, { text: 'потеря контракта' }, { text: 'капекс свёрнут' }],
    news: [], filings: [],
  });
  assert.ok(s.includes('0. рост <10% два квартала') && s.includes('2. капекс свёрнут'), 'условия пронумерованы');
  assert.ok(s.includes('Текущее состояние тезиса: watch'), 'состояние на входе');
  assert.ok(s.includes('severity'), 'жёсткость условия (hard/soft)');
  assert.ok(s.includes('не выдумывай факты'));
  assert.ok(s.includes('"verdicts"'));
});

test('levelsDerive.user: damaged — якоря EPS/мультипликатор/подтверждение; dead — план выхода', () => {
  const rec = { t: 'ZTS', state: 'damaged', thesis: 'защита животных', pillars: ['ценовая власть'], damaged_pillars: ['ценовая власть'], recovery_conditions: [] };
  const s = PROMPTS.levelsDerive.user({ rec, px: 120, sigmaUsd: 25, news: [], filings: [] });
  assert.ok(s.includes('damaged'));
  assert.ok(s.includes('гайденс'), 'инструкция про базу EPS');
  assert.ok(s.includes('multiple_low'));
  assert.ok(s.includes('confirm_event'), 'условие подтверждения обязательно');
  const dead = PROMPTS.levelsDerive.user({ rec: { ...rec, state: 'dead' }, px: 120, sigmaUsd: null, news: [], filings: [] });
  assert.ok(dead.includes('план выхода') && dead.includes('exit_deadline_days'));
  const empty = PROMPTS.levelsDerive.user({ rec: { t: 'X', state: 'intact' }, px: null, sigmaUsd: null, news: [], filings: [] });
  assert.ok(!empty.includes('undefined'));
});

test('thesisReview.user: отчёт против опор, deterioration, подтверждения восстановления', () => {
  const rec = { t: 'PSN', state: 'damaged', thesis: 'т', pillars: ['a'], damaged_pillars: ['a'], recovery_conditions: ['первое', 'второе'] };
  const s = PROMPTS.thesisReview.user({ rec, earnings: { date: '2026-08-20', surprisePct: -4.2 }, px: 50, dayMove: -0.08, news: [], filings: [] });
  assert.ok(s.includes('2026-08-20') && s.includes('-4.2%'));
  assert.ok(s.includes('0. первое') && s.includes('1. второе'), 'условия пронумерованы');
  assert.ok(s.includes('deterioration'));
  assert.ok(s.includes('proposed_state'));
});

test('buyCheck.user: чек-лист и мандат в контексте, решение однозначно', () => {
  const s = PROMPTS.buyCheck.user({
    t: 'TSM', usd: 500, px: 400,
    thesis: { state: 'intact', history: [{ from: 'watch', to: 'intact' }] },
    calendar: { days: 3 },
    movement: { class: 'beta', reason: 'сектор качнуло' },
    levels: { active: true, t1: 380, t2: 355, t3: 340, inZone: false, until: null },
    mandate: { aiPct: 0.36, namePctAfter: 0.05, cashPctAfter: 0.04 },
    baserates: { class: 'guidance_cut', median12m: -2 },
    detector: null, news: [], filings: [],
  });
  assert.ok(s.includes('TSM') && s.includes('$500'));
  assert.ok(s.includes('через 3 дн') && s.includes('БИНАРНЫЙ РИСК'));
  assert.ok(s.includes('потолок 35%'));
  assert.ok(s.includes('buy_full|buy_half|wait|no|no_decision'));
  assert.ok(s.includes('НИКОГДА не выдумывай'));
});

test('committee: персоны ролей + контекст портфеля + грамматика', () => {
  const ctx = {
    total: 17000, verdict: 'ОКНА НЕТ', topFactors: ['SMH: 0.61'], detectorFlags: ['PSN thesis_damage'],
    earnings: ['NVDA через 5 дн'], tickers: ['TSM', 'AVGO'], spx: 5500, vix: 16,
  };
  const bull = PROMPTS.committee.user({ role: 'bull', ctx });
  const bear = PROMPTS.committee.user({ role: 'bear', ctx });
  assert.ok(bull.includes('убеждённый бык') && !bull.includes('убеждённый медведь'), 'персона подставлена');
  assert.ok(bear.includes('убеждённый медведь'));
  assert.ok(bull.includes('$17000') && bull.includes('PSN thesis_damage') && bull.includes('NVDA через 5 дн'));
  assert.ok(bull.includes('price_above') && bull.includes('vix_below'), 'грамматика событий');
  assert.ok(bull.includes('РОвно пять'.replace('Ро','Ро')) || bull.includes('РОвНО ПЯТЬ') || /ровно пять/i.test(bull), 'пять прогнозов');
  // неизвестная роль — явная ошибка, не тихий undefined
  assert.throws(() => PROMPTS.committee.user({ role: 'alien', ctx }), /роль/i);
});

test('baserates.user: событие инвестора и список эмпирических классов', () => {
  const s = PROMPTS.baserates.user({ text: 'срез гайденса дважды', classes: 'drawdown40 (эмпирика: 214 событий), shock15 (эмпирика: 89 событий)' });
  assert.ok(s.includes('срез гайденса дважды'));
  assert.ok(s.includes('drawdown40'));
  assert.ok(s.includes('МНЕНИЕ МОДЕЛИ'), 'приор помечен как мнение');
});
