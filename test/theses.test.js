'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// файл тезисов — в отдельный временный (параллельные тесты не делят состояние)
const TMP = path.join(__dirname, '..', 'data', 'cache', '.theses-test.json');
process.env.THESES_FILE = TMP;
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);

const theses = require('../src/lab/theses');

const baseRec = (state, extra = {}) => ({
  t: 'TST', state, thesis: 'тестовый тезис', pillars: ['опора A', 'опора B'],
  damaged_pillars: [], history: [], levels: null, levels_history: [],
  recovery_conditions: ['условие 1', 'условие 2'], clean_reports: 0,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
});

test('nextState: правила переходов по confidence и жёсткости фальсификации', () => {
  assert.deepStrictEqual(theses.nextState('intact', { kind: 'damage_strong' }), { to: 'damaged', changed: true });
  assert.deepStrictEqual(theses.nextState('watch', { kind: 'damage_strong' }), { to: 'damaged', changed: true });
  assert.deepStrictEqual(theses.nextState('recovering', { kind: 'damage_strong' }), { to: 'damaged', changed: true });
  assert.strictEqual(theses.nextState('dead', { kind: 'damage_strong' }), null, 'из dead пути нет');
  assert.deepStrictEqual(theses.nextState('intact', { kind: 'damage_weak' }), { to: 'watch', changed: true });
  assert.deepStrictEqual(theses.nextState('recovering', { kind: 'damage_weak' }), { to: 'watch', changed: true });
  assert.strictEqual(theses.nextState('watch', { kind: 'damage_weak' }), null, 'watch уже есть');
  assert.deepStrictEqual(theses.nextState('intact', { kind: 'falsify_hard' }), { to: 'dead', changed: true });
  assert.deepStrictEqual(theses.nextState('damaged', { kind: 'falsify_soft' }), { to: 'damaged', changed: true });
  assert.strictEqual(theses.nextState('dead', { kind: 'falsify_soft' }), null);
});

test('reduce: damage_strong из intact — история, аннулирование уровней, дедлайн пересмотра', () => {
  const rec = baseRec('intact', { levels: { t1: 100, t2: 90, t3: 80, derived_at: 'x', basis: 'старое' } });
  const { rec: out, transition } = theses.reduce(rec, {
    kind: 'damage_strong', source: 'detector', trigger: 'anomaly',
    evidence: 'гайденс срезан', pillar: 'рост выручки',
    proposal: { state: 'damaged', note: 'мнение' },
  });
  assert.strictEqual(transition.from, 'intact');
  assert.strictEqual(transition.to, 'damaged');
  assert.strictEqual(out.state, 'damaged');
  assert.strictEqual(out.levels, null, 'старые уровни аннулированы');
  assert.strictEqual(out.history.length, 1);
  assert.strictEqual(out.history[0].source, 'detector');
  assert.strictEqual(out.history[0].evidence, 'гайденс срезан');
  assert.ok(out.review?.due, 'появился дедлайн пересмотра');
  assert.ok(out.damaged_pillars.includes('рост выручки'), 'опора задокументирована');
  assert.strictEqual(out.proposed?.state, 'damaged', 'мнение LLM сохранено рядом');
});

test('reduce: earnings в damaged — два чистых отчёта → recovering, ухудшение сбрасывает счётчик', () => {
  let rec = baseRec('damaged', { damaged_pillars: ['опора A'] });
  let r = theses.reduce(rec, { kind: 'earnings', source: 'earnings', deterioration: false });
  assert.strictEqual(r.rec.state, 'damaged');
  assert.strictEqual(r.rec.clean_reports, 1, 'первый чистый отчёт');
  r = theses.reduce(r.rec, { kind: 'earnings', source: 'earnings', deterioration: false });
  assert.strictEqual(r.rec.state, 'recovering', 'второй чистый подряд → recovering');
  assert.strictEqual(r.rec.damaged_pillars.length, 0, 'опоры очищены');
  // ухудшение сбрасывает счётчик
  let r2 = theses.reduce(baseRec('damaged', { clean_reports: 1 }), { kind: 'earnings', deterioration: true });
  assert.strictEqual(r2.rec.state, 'damaged');
  assert.strictEqual(r2.rec.clean_reports, 0);
  assert.strictEqual(r2.transition.to, 'damaged', 'переход нет — но пишем сброс');
});

test('reduce: earnings в watch → intact на чистом отчёте; в recovering → intact при всех условиях', () => {
  const w = theses.reduce(baseRec('watch'), { kind: 'earnings', deterioration: false });
  assert.strictEqual(w.rec.state, 'intact');
  const wd = theses.reduce(baseRec('watch'), { kind: 'earnings', deterioration: true });
  assert.strictEqual(wd.rec.state, 'damaged');
  const rec = theses.reduce(baseRec('recovering'), { kind: 'earnings', deterioration: false, recovery_confirmed: [0, 1] });
  assert.strictEqual(rec.rec.state, 'intact', 'все условия подтверждены');
  const half = theses.reduce(baseRec('recovering'), { kind: 'earnings', deterioration: false, recovery_confirmed: [0] });
  assert.strictEqual(half.rec.state, 'recovering', 'подтверждена только половина условий');
});

test('reduce: manual — валидация состояния; без перехода фиксируется только предложение LLM', () => {
  const rec = baseRec('intact');
  const no = theses.reduce(rec, { kind: 'manual', to: 'intact' });
  assert.strictEqual(no.transition, null);
  const yes = theses.reduce(rec, { kind: 'manual', to: 'watch', source: 'manual', evidence: 'вижу то, чего не видит машина' });
  assert.strictEqual(yes.rec.state, 'watch');
  assert.strictEqual(yes.rec.history[0].source, 'manual');
  assert.throws(() => theses.reduce(rec, { kind: 'manual', to: 'zombie' }), /состояние/);
  const prop = theses.reduce(rec, { kind: 'damage_weak', source: 'detector', proposal: { state: 'damaged' } });
  assert.strictEqual(prop.rec.proposed.state, 'damaged', 'мнение сохранено даже без перехода');
});

test('seedFromMeta: broken → damaged с датой пересмотра, sell → dead, обычные → intact; идемпотентен', () => {
  const store = theses.seedFromMeta({ meta: {
    PSN: { tag: 'quality', st: 'broken', lv: null, note: 'гайденс срезан', reviewBy: '2026-08-27', check: 'стабилизация' },
    AYTU: { tag: 'exit', st: 'sell', lv: null, note: 'продать' },
    TSM: { tag: 'core', lv: [380, 355, 340], note: 'AI' },
  }, registry: [] });
  assert.strictEqual(store.items.PSN.state, 'damaged');
  assert.strictEqual(store.items.PSN.review.due, '2026-08-27');
  assert.deepStrictEqual(store.items.PSN.recovery_conditions, ['стабилизация']);
  assert.strictEqual(store.items.AYTU.state, 'dead');
  assert.strictEqual(store.items.TSM.state, 'intact');
  // повторный сидинг не трогает существующее
  const again = theses.seedFromMeta({ meta: { PSN: { tag: 'quality', st: 'broken', lv: null, note: '' } } });
  assert.strictEqual(again.items.PSN.review.due, '2026-08-27', 'существующая запись не перезаписана');
});

test('reviewQueue: просроченные — красным наверх; dead без плана выхода; зависшие damaged', () => {
  const items = {
    A: baseRec('damaged', { t: 'A', review: { due: '2020-01-01', reason: 'просрочен' } }),
    B: baseRec('watch', { t: 'B', review: { due: '2030-01-01', reason: 'далеко' } }),
    C: baseRec('dead', { t: 'C' }),
    D: baseRec('intact', { t: 'D' }),
  };
  const q = theses.reviewQueue({ items, now: new Date('2026-08-24T12:00:00Z') });
  assert.strictEqual(q[0].t, 'A');
  assert.strictEqual(q[0].priority, 0);
  assert.ok(q.some(x => x.t === 'C' && x.priority === 1), 'dead без плана выхода');
  assert.ok(q.some(x => x.t === 'B'), 'запланированный пересмотр в очереди');
  assert.ok(!q.some(x => x.t === 'D'), 'intact без пересмотра не попадает');
});

test('applyManual: требует обоснование; applyEvent на пустоту — явная ошибка', async () => {
  theses.saveRecord(baseRec('watch'));
  await assert.rejects(() => theses.applyManual('TST', 'damaged', 'коротко'), /обоснования/);
  await assert.rejects(() => theses.applyManual('NOPE', 'damaged', 'достаточно длинное обоснование'), /нет записи/);
  const r = await theses.applyManual('TST', 'damaged', 'гайденс срезан третий раз, вижу сам', { derive: null });
  assert.strictEqual(r.rec.state, 'damaged');
});

test('syncFromFalsify: создаёт запись intact, обновляет существующую не трогая состояние', () => {
  const created = theses.syncFromFalsify('NEWT', { thesis: 'новый тезис', pillars: ['a', 'b'], recovery_conditions: ['x'] });
  assert.strictEqual(created.state, 'intact');
  assert.deepStrictEqual(created.pillars, ['a', 'b']);
  const cur = theses.get('NEWT');
  theses.syncFromFalsify('NEWT', { thesis: 'обновлённый тезис', pillars: ['c'], recovery_conditions: [] });
  const again = theses.get('NEWT');
  assert.strictEqual(again.state, 'intact');
  assert.strictEqual(again.thesis, 'обновлённый тезис');
  assert.deepStrictEqual(again.pillars, ['c']);
  assert.deepStrictEqual(again.recovery_conditions, ['x'], 'пустой список не затирает');
});

test('reviewOverdue: производная проверка дедлайна', () => {
  assert.strictEqual(theses.reviewOverdue({ review: { due: '2020-01-01' } }), true);
  assert.strictEqual(theses.reviewOverdue({ review: { due: '2030-01-01' } }), false);
  assert.strictEqual(theses.reviewOverdue(null), false);
});
