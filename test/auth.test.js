'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// изолируемся от реального .env: патчим loadEnv ДО require auth
const env = require('../src/env');
env.loadEnv = () => ({});
process.env.APP_PASSWORD = 'test-secret';

const auth = require('../src/auth');

const fakeReq = cookie => ({ headers: { cookie } });
const fakeRes = () => {
  const r = { headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  return r;
};

test('пароль не задан — авторизация выключена, все владельцы', () => {
  delete process.env.APP_PASSWORD;
  assert.strictEqual(auth.enabled(), false);
  assert.strictEqual(auth.isOwner(fakeReq('')), true);
  assert.ok(auth.login('1.1.1.1', 'что угодно', fakeRes()));
  process.env.APP_PASSWORD = 'test-secret';
});

test('токен: подпись → проверка; мусор, подделка и просрочка отклоняются', () => {
  assert.ok(auth.verifyToken(auth.signToken(3600e3)));
  assert.ok(!auth.verifyToken('abc'));
  assert.ok(!auth.verifyToken(auth.signToken(3600e3) + '00'));
  assert.ok(!auth.verifyToken(auth.signToken(-1000)));
  const [exp] = auth.signToken(3600e3).split('.');
  assert.ok(!auth.verifyToken(`${+exp + 99999999}.deadbeef`));
});

test('isOwner: cookie владельца проходит, без cookie — гость', () => {
  const res = fakeRes();
  assert.ok(auth.login('1.2.3.4', 'test-secret', res));
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /pt_auth=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(auth.isOwner(fakeReq(cookie.split(';')[0])));
  assert.strictEqual(auth.isOwner(fakeReq('')), false);
  assert.strictEqual(auth.isOwner(fakeReq('pt_auth=123.456')), false);
});

test('login: неверный пароль отклоняется, перебор блокируется', () => {
  const ip = '9.9.9.9';
  assert.ok(!auth.login(ip, 'wrong', fakeRes()));
  for (let i = 0; i < 10; i++) auth.login(ip, 'wrong', fakeRes());
  assert.ok(!auth.login(ip, 'test-secret', fakeRes()), 'верный пароль после серии неудач тоже не пускается');
});

test('смена пароля инвалидирует ранее выданные токены', () => {
  const res = fakeRes();
  auth.login('5.5.5.5', 'test-secret', res);
  const cookie = res.headers['set-cookie'].split(';')[0];
  assert.ok(auth.isOwner(fakeReq(cookie)));
  process.env.APP_PASSWORD = 'new-secret';
  assert.strictEqual(auth.isOwner(fakeReq(cookie)), false);
  process.env.APP_PASSWORD = 'test-secret';
  assert.ok(auth.isOwner(fakeReq(cookie)));
});

test('logout стирает cookie', () => {
  const res = fakeRes();
  auth.logout(res);
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
});
