'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// мокаем сеть: chart() зовёт глобальный fetch в момент вызова
function mockChartJson({ price, chartPreviousClose, closes }) {
  return {
    chart: {
      result: [{
        meta: { regularMarketPrice: price, chartPreviousClose },
        indicators: { quote: [{ close: closes }] },
      }],
    },
  };
}

test('prevClose = предпоследняя точка ряда, а не meta.chartPreviousClose', async (t) => {
  // регрессия A1: при range=3mo Yahoo кладёт в chartPreviousClose закрытие
  // ПЕРЕД началом диапазона (3 месяца назад) — это не вчерашний день
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => mockChartJson({
      price: 45.52,
      chartPreviousClose: 22.65, // закрытие 3 месяца назад (то, что ломало «День»)
      closes: [41.0, 44.0, 45.52], // null-ы фильтруются
    }),
  });
  const { chart } = require('../src/yahoo');
  const d = await chart('DFTX', '3mo');
  assert.strictEqual(d.prevClose, 44.0, 'prevClose должен быть closes.at(-2)');
  const day = (d.price / d.prevClose - 1) * 100;
  assert.ok(Math.abs(day - 3.45) < 0.05, 'дневное изменение считается от prevClose');
});

test('prevClose = null, если в ряду меньше двух точек', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => mockChartJson({ price: 10, chartPreviousClose: 9, closes: [10, null] }),
  });
  const { chart } = require('../src/yahoo');
  const d = await chart('X');
  assert.strictEqual(d.prevClose, null, 'одна точка — вчерашнего закрытия нет');
});
