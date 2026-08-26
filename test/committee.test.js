'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PRED = path.join(__dirname, '..', 'data', 'predictions.jsonl');
const hadPred = fs.existsSync(PRED);
if (hadPred) fs.copyFileSync(PRED, path.join(__dirname, '..', 'data', 'cache', '.pred-backup-tmp'));
fs.writeFileSync(PRED, '');

const C = require('../src/lab/committee');

after(() => {
  if (hadPred) {
    fs.copyFileSync(path.join(__dirname, '..', 'data', 'cache', '.pred-backup-tmp'), PRED);
    fs.unlinkSync(path.join(__dirname, '..', 'data', 'cache', '.pred-backup-tmp'));
  } else fs.unlinkSync(PRED);
});

test('resolveEvent: грамматика price/index/vix, границы включительно', () => {
  const px = { TSM: 110, '^GSPC': 6000, '^VIX': 18 };
  assert.strictEqual(C.resolveEvent({ kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 30 }, px), true);
  assert.strictEqual(C.resolveEvent({ kind: 'price_above', t: 'TSM', ref: 100, x: 0.11, horizon_days: 30 }, px), false);
  assert.strictEqual(C.resolveEvent({ kind: 'price_below', t: 'TSM', ref: 100, x: 0.05, horizon_days: 30 }, px), false);
  assert.strictEqual(C.resolveEvent({ kind: 'index_above', ref: 5500, x: 0.09, horizon_days: 30 }, px), true);
  assert.strictEqual(C.resolveEvent({ kind: 'vix_below', level: 20, horizon_days: 30 }, px), true);
  assert.strictEqual(C.resolveEvent({ kind: 'vix_above', level: 15, horizon_days: 30 }, px), true);
  assert.strictEqual(C.resolveEvent({ kind: 'vix_above', level: 18, horizon_days: 30 }, px), true, 'граница включительно');
  assert.strictEqual(C.resolveEvent({ kind: 'wat', ref: 1 }, px), null, 'неизвестный вид → null');
  assert.strictEqual(C.resolveEvent({ kind: 'price_above', t: 'NOPE', ref: 1, x: 0.1, horizon_days: 30 }, px), null);
});

test('validateEvent: режет мусор из LLM, нормализует числа', () => {
  assert.ok(C.validateEvent({ kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 30 }));
  assert.ok(!C.validateEvent({ kind: 'price_above', t: 'TSM', ref: 100, x: 50, horizon_days: 30 }), 'x ≤ 50%');
  assert.ok(!C.validateEvent({ kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 0 }), 'горизонт ≥ 1');
  assert.ok(!C.validateEvent({ kind: 'vix_above', level: -1, horizon_days: 5 }));
  assert.ok(C.validateEvent({ kind: 'vix_above', level: 20, horizon_days: 30, junk: 'x' }), 'лишние поля не мешают');
});

test('runCommittee: 4 роли × 5 прогнозов, валидные события, append-only', async () => {
  const llm = { chat: async () => ({
    predictions: [
      { kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 30, prob: 0.4, rationale: 'спрос' },
      { kind: 'price_below', t: 'NOW', ref: 130, x: 0.15, horizon_days: 60, prob: 0.3, rationale: 'дорого' },
      { kind: 'index_above', ref: 5500, x: 0.05, horizon_days: 90, prob: 0.5, rationale: 'цикл' },
      { kind: 'vix_above', level: 25, horizon_days: 30, prob: 0.25, rationale: 'события' },
      { kind: 'vix_below', level: 14, horizon_days: 45, prob: 0.2, rationale: 'спокойствие' },
      { kind: 'price_above', t: 'BAD', ref: 1, x: 99, horizon_days: 5, prob: 0.9, rationale: 'мусор' }, // будет отфильтрован
    ],
  }) };
  const res = await C.runCommittee({ llm, contextLoader: async () => ({ total: 17000, roles: 4 }), volLoader: async () => ({}) });
  assert.strictEqual(res.appended, 20, '4 роли × 5 валидных (σ недоступна — информативность решится при оценке)');
  const lines = fs.readFileSync(PRED, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 20);
  const rec = JSON.parse(lines[0]);
  assert.ok(['bull', 'bear', 'devil', 'baserates'].includes(rec.role));
  assert.ok(rec.event.kind && rec.prob >= 0.05 && rec.prob <= 0.95);
  assert.ok(rec.outcome == null, 'исход ещё не известен');
});

test('runCommittee: набор без короткого горизонта отклоняется; неинформативные режутся на входе', async () => {
  fs.writeFileSync(PRED, '');
  const longOnly = { chat: async () => ({ predictions: [
    { kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 200, prob: 0.7, rationale: '' },
    { kind: 'price_above', t: 'NOW', ref: 130, x: 0.1, horizon_days: 180, prob: 0.6, rationale: '' },
    { kind: 'index_above', ref: 5500, x: 0.05, horizon_days: 120, prob: 0.65, rationale: '' },
  ] }) };
  const res1 = await C.runCommittee({ llm: longOnly, contextLoader: async () => ({}), volLoader: async () => ({}) });
  assert.strictEqual(res1.appended, 0, 'набор целиком отклонён');
  assert.ok(res1.rejected.length === 4 && res1.rejected[0].reason.includes('горизонтом'));

  // prob ≈ baseline → прогноз неинформативен, на входе отбрасывается.
  // σ=0.012, x=2%, 30д → baseline ≈ 1−Φ(0.301) ≈ 0.38:
  // prob 0.40 (|Δ|=0.02 < 0.10) режется, 0.90 (|Δ|=0.52) остаётся
  const near = { chat: async () => ({ predictions: [
    { kind: 'price_above', t: 'TSM', ref: 100, x: 0.02, horizon_days: 30, prob: 0.40, rationale: '' },
    { kind: 'price_above', t: 'NOW', ref: 130, x: 0.02, horizon_days: 30, prob: 0.90, rationale: '' },
  ] }) };
  const res2 = await C.runCommittee({ llm: near, contextLoader: async () => ({}), volLoader: async () => ({ TSM: 0.012, NOW: 0.012 }) });
  assert.strictEqual(res2.dropped.length, 4, 'по одному неинформативному на роль');
  assert.strictEqual(res2.appended, 4, 'информативные остались');
  assert.ok(res2.dropped.every(d => d.prob === 0.40));
  const kept = fs.readFileSync(PRED, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(kept.every(r => r.prob === 0.90));
});

test('baselineProb + sigmaBefore: случайное блуждание как честный нуль-гипотезный прогноз', () => {
  // σ→0: движение практически невозможно → выше порога почти наверняка нет
  const hi = C.baselineProb({ kind: 'price_above', t: 'X', ref: 100, x: 0.1, horizon_days: 30 }, 1e-9);
  assert.ok(hi < 0.01);
  const lo = C.baselineProb({ kind: 'price_below', t: 'X', ref: 100, x: 0.1, horizon_days: 30 }, 1e-9);
  assert.ok(lo < 0.01, 'ниже тоже нет');
  // σ большая: примерно монетка
  const mid = C.baselineProb({ kind: 'price_above', t: 'X', ref: 100, x: 0.1, horizon_days: 30 }, 0.5);
  assert.ok(Math.abs(mid - 0.5) < 0.05, 'симметрично вокруг 0.5: ' + mid);
  assert.strictEqual(C.baselineProb({ kind: 'vix_above', level: 20, horizon_days: 30 }, 0.02), null, 'VIX без уровня на момент ts');
  // σ считается по точкам ДО ts (нужно ≥21 точки до cut)
  const closes = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)));
  const ts = closes.map((_, i) => (i + 20) * 86400); // ts в секундах
  const cut = (24 + 20) * 86400 * 1000; // обрезаем после 25-й точки
  const s = C.sigmaBefore(cut, { closes, ts });
  assert.ok(s > 0 && s < 0.05, 'σ по окну до cut: ' + s);
  assert.strictEqual(C.sigmaBefore(0, { closes, ts }), null, 'пустое окно — null');
});

test('scoreMatured + brierByRole + BSS + консенсус', async () => {
  // подкладываем созревшие прогнозы с известными исходами
  const now = Date.now();
  const rows = [
    { ts: new Date(now - 40 * 864e5).toISOString(), role: 'bull', event: { kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 30 }, prob: 0.8, rationale: '' },
    { ts: new Date(now - 40 * 864e5).toISOString(), role: 'bull', event: { kind: 'price_below', t: 'NOW', ref: 130, x: 0.15, horizon_days: 30 }, prob: 0.2, rationale: '' },
    { ts: new Date(now - 40 * 864e5).toISOString(), role: 'bear', event: { kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 30 }, prob: 0.3, rationale: '' },
    { ts: new Date(now - 5 * 864e5).toISOString(), role: 'bear', event: { kind: 'vix_above', level: 25, horizon_days: 30 }, prob: 0.5, rationale: '' }, // не созрел
  ];
  fs.writeFileSync(PRED, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const scored = await C.scoreMatured({ priceLoader: async syms => ({ TSM: 110, NOW: 125, '^GSPC': 5000, '^VIX': 18 }), historyLoader: async () => ({}) });
  assert.strictEqual(scored, 3, 'незрелый vix_above не тронут');
  const lines = fs.readFileSync(PRED, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.filter(l => JSON.parse(l).outcome == null).length, 1);

  const brier = C.brierByRole();
  // bull: среднее из (0.8−1)² и (0.2−0)² = 0.04; bear: (0.3−1)² = 0.49
  assert.ok(Math.abs(brier.bull - 0.04) < 1e-9);
  assert.ok(Math.abs(brier.bear - 0.49) < 1e-9);

  const w = C.consensusWeights();
  const weights = w.weights || {};
  assert.ok(Math.abs(weights.bull + weights.bear - 1) < 1e-9, 'softmax нормирован (фолбэк на Brier, истории BSS нет)');
  assert.ok(weights.bull > weights.bear, 'лучшая калибровка — больший вес');

  const cal = C.calibration();
  assert.ok(Array.isArray(cal) && cal.length === 5);
  assert.ok(cal.every(b => b.n >= 0));
  assert.ok(cal.filter(b => b.n > 0).every(b => b.hitRate != null), 'непустые бакеты имеют частоту');
});

test('bssByRole: информативные прогнозы против baseline; хуже монетки — ниже нуля', () => {
  const now = Date.now();
  const mk = (role, prob, baseline, outcome, informative = true) => ({
    ts: new Date(now - 40 * 864e5).toISOString(), role,
    event: { kind: 'price_above', t: 'TSM', ref: 100, x: 0.1, horizon_days: 30 },
    prob, baseline, outcome, informative,
  });
  fs.writeFileSync(PRED, [
    // bull информативен и точен: BS 0.01 против baseline BS 0.16 → BSS = +0.94
    JSON.stringify(mk('bull', 0.9, 0.6, true)),
    // bear информативен, но хуже baseline: BS 0.81 против 0.01 → BSS = −80
    JSON.stringify(mk('bear', 0.1, 0.9, true)),
    // неинформативный — не считается вовсе
    JSON.stringify(mk('bear', 0.5, 0.5, false, false)),
  ].join('\n') + '\n');
  const bss = C.bssByRole();
  assert.ok(Math.abs(bss.bull.bss - (1 - 0.01 / 0.16)) < 1e-9, 'bull BSS: ' + bss.bull.bss);
  assert.ok(bss.bear.bss < 0, 'хуже монетки — ниже нуля');
  assert.strictEqual(bss.bear.n, 1, 'неинформативный не вошёл');
});
