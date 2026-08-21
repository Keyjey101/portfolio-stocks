'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseRss } = require('../src/news');

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Yahoo Finance</title>
<item><title><![CDATA[Company cuts guidance for second straight quarter]]></title>
<link>https://finance.yahoo.com/news/a</link><pubDate>Fri, 21 Aug 2026 14:00:00 +0000</pubDate></item>
<item><title>Plain title without CDATA</title>
<link>https://finance.yahoo.com/news/b</link>
<pubDate>Thu, 20 Aug 2026 10:30:00 +0000</pubDate></item>
<item><title><![CDATA[<b>Malformed &amp; entity</b>]]></title>
<link>https://finance.yahoo.com/news/c</link><pubDate>Wed, 19 Aug 2026 09:00:00 +0000</pubDate></item>
</channel></rss>`;

test('parseRss: заголовки, ссылки, даты; CDATA и сущности срезаются', () => {
  const items = parseRss(FIXTURE);
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].title, 'Company cuts guidance for second straight quarter');
  assert.strictEqual(items[1].title, 'Plain title without CDATA');
  assert.ok(items[2].title.includes('Malformed'));
  assert.strictEqual(items[0].link, 'https://finance.yahoo.com/news/a');
  assert.ok(Number.isFinite(items[0].date));
});

test('parseRss: мусор → пустой массив, не throw', () => {
  assert.deepEqual(parseRss(''), []);
  assert.deepEqual(parseRss('<html>не rss</html>'), []);
});
