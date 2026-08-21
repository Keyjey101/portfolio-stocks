'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { matrixPower, simulateMC } = require('../src/lab/mc');

test('matrixPower: A^1 = A, A^2 вручную, строки стохастичны', () => {
  const A = [[0.9, 0.1], [0.2, 0.8]];
  const A1 = matrixPower(A, 1);
  assert.deepEqual(A1, A);
  const A2 = matrixPower(A, 2);
  assert.ok(Math.abs(A2[0][0] - 0.83) < 1e-12 && Math.abs(A2[1][1] - 0.66) < 1e-12);
  for (const row of matrixPower(A, 21)) assert.ok(Math.abs(row.reduce((s, v) => s + v, 0) - 1) < 1e-9);
});

// один «пул» с почти детерминированной дневной доходностью μ=2e-4
function nearDeterministicPool(n = 300, mu = 2e-4) {
  return Array.from({ length: n }, () => mu + (Math.random() === 2 ? 1 : 0)); // константа
}

test('simulateMC: детерминированный пул — медиана терминала ≈ start·e^{μ·2520}', () => {
  const pool = nearDeterministicPool();
  const res = simulateMC({
    pools: [pool], A: [[1]], pi: [1],
    years: 10, monthlyUsd: 0, startValue: 1000, paths: 500, seed: 3,
  });
  const expected = 1000 * Math.exp(2e-4 * 2520);
  assert.ok(Math.abs(res.terminal.p50 - expected) / expected < 0.02,
    'p50=' + res.terminal.p50 + ' expected=' + expected);
  assert.ok(Math.abs(res.terminal.p5 - expected) / expected < 0.02, 'разброса нет');
});

test('simulateMC: довнесения растят медиану примерно на FV аннуитета', () => {
  const pool = nearDeterministicPool();
  const base = { years: 10, pools: [pool], A: [[1]], pi: [1], startValue: 1000, paths: 800, seed: 5 };
  const no = simulateMC({ ...base, monthlyUsd: 0 });
  const yes = simulateMC({ ...base, monthlyUsd: 250 });
  const muM = 2e-4 * 21; // месячная лог-доходность
  const months = 120;
  // FV обычной аннуитета при непрерывном начислении muM: c·Σ_{k=1..M} e^{muM·k}
  let fv = 0;
  for (let k = 1; k <= months; k++) fv += 250 * Math.exp(muM * k);
  const diff = yes.terminal.p50 - no.terminal.p50;
  assert.ok(Math.abs(diff - fv) / fv < 0.05, 'diff=' + diff.toFixed(0) + ' fv=' + fv.toFixed(0));
  assert.strictEqual(yes.totalContrib, 30000);
});

test('simulateMC: тот же seed — идентичный результат; yearly заполнен', () => {
  const pool = nearDeterministicPool();
  const args = { pools: [pool], A: [[1]], pi: [1], years: 10, monthlyUsd: 100, startValue: 500, paths: 200, seed: 9 };
  const a = simulateMC(args), b = simulateMC(args);
  assert.deepEqual(a.terminal, b.terminal);
  assert.strictEqual(a.yearly.length, 10);
  assert.ok(a.yearly[9].p50 > a.yearly[0].p50);
  assert.ok(a.maxDD.p50 >= 0 && a.maxDD.p50 <= 1);
});

test('simulateMC: режим с большими просадками даёт больший maxDD', () => {
  const calm = Array.from({ length: 300 }, () => 0.0003);
  const wild = Array.from({ length: 300 }, (_, i) => (i % 21 === 0 ? -0.09 : 0.003)); // −3% за блок
  const calmRes = simulateMC({ pools: [calm], A: [[1]], pi: [1], years: 10, monthlyUsd: 0, startValue: 1000, paths: 300, seed: 2 });
  const wildRes = simulateMC({ pools: [wild], A: [[1]], pi: [1], years: 10, monthlyUsd: 0, startValue: 1000, paths: 300, seed: 2 });
  assert.ok(wildRes.maxDD.p50 > calmRes.maxDD.p50,
    'wild=' + wildRes.maxDD.p50 + ' calm=' + calmRes.maxDD.p50);
  assert.ok(wildRes.maxDD.p50 > 0.5, 'десять лет по −3%/мес — глубокая просадка: ' + wildRes.maxDD.p50);
});
