'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseTickerMap, parseFilings } = require('../src/edgar');

const MAP = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 104169, ticker: 'WMT', title: 'Walmart Inc.' },
  '2': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc. (duplicate)' },
};

test('parseTickerMap: тикер → 10-значный CIK, дубликат не ломает', () => {
  const m = parseTickerMap(MAP);
  assert.strictEqual(m.AAPL, '0000320193');
  assert.strictEqual(m.WMT, '000104169');
  assert.strictEqual(Object.keys(m).length, 2);
});

const SUBMISSIONS = {
  cik: '320193',
  filings: {
    recent: {
      form: ['10-K', '8-K', '4', '10-Q', '8-K', 'S-8'],
      filingDate: ['2026-08-01', '2026-07-20', '2026-07-15', '2026-07-10', '2026-06-30', '2026-06-01'],
      accessionNumber: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
      primaryDocument: ['a.htm', 'b.htm', 'c.htm', 'd.htm', 'e.htm', 'f.htm'],
    },
  },
};

test('parseFilings: только 8-K/10-Q/10-K, свежие сверху, полные URL', () => {
  const f = parseFilings(SUBMISSIONS, { cik: '0000320193', forms: ['8-K', '10-Q', '10-K'], limit: 5 });
  assert.strictEqual(f.length, 4);
  assert.strictEqual(f[0].form, '10-K');
  assert.strictEqual(f[0].url, 'https://www.sec.gov/Archives/edgar/data/320193/A1/a.htm');
  assert.ok(f[0].date >= f[1].date);
  // только три формы, 4 и S-8 отфильтрованы
  assert.ok(f.every(x => ['8-K', '10-Q', '10-K'].includes(x.form)));
});

test('parseFilings: пустые данные → []', () => {
  assert.deepEqual(parseFilings({}, { cik: '1' }), []);
  assert.deepEqual(parseFilings({ filings: { recent: {} } }, { cik: '1' }), []);
});
