'use strict';
/* ─────────────────────────────────────────────────────────────
   Общий хелпер обеих страниц: публичный/владельческий режим
   и тосты (в app.js свой toast с richer-цветами — там он уже есть).
   OWNER/AUTH_ON выставляются после /api/session. Сервер всё равно
   проверяет каждый запрос — это только UI-обвязка.
   ───────────────────────────────────────────────────────────── */
var OWNER=false, AUTH_ON=false;

var TC={g:'#0e8a5f',y:'#a97b10',o:'#c0621c',r:'#c43d33',d:'#757b80'};
function basicToast(msg,type){
  var box=document.getElementById('toasts');
  if(!box){box=document.createElement('div');box.id='toasts';document.body.appendChild(box)}
  var t=document.createElement('div');
  t.className='toast';t.style.setProperty('--tc',TC[type]||'#8f6a1e');
  t.textContent=msg;box.appendChild(t);
  setTimeout(function(){t.classList.add('out');setTimeout(function(){t.remove()},330)},3600);
}

function initAuth(onState){
  fetch('/api/session',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
    OWNER=!!s.owner;AUTH_ON=!!s.auth;
  }).catch(function(){OWNER=false;AUTH_ON=false})
  .then(function(){
    document.body.classList.add(OWNER?'owner':'guest');
    /* иконка ключ/замок переключается классом body.owner в CSS */
    var btn=document.getElementById('btnAuth');
    if(btn)btn.title=OWNER?'Выйти из режима владельца':'Вход владельца';
    if(onState)onState(OWNER);
  });

  var btn=document.getElementById('btnAuth');
  if(btn)btn.addEventListener('click',function(){
    if(OWNER){
      if(confirm('Выйти из режима владельца?'))fetch('/api/logout',{method:'POST'}).then(function(){location.reload()});
      return;
    }
    var m=document.getElementById('authModal');
    if(!m)return;
    m.hidden=false;
    var pw=document.getElementById('authPw');
    pw.value='';document.getElementById('authErr').textContent='';
    setTimeout(function(){pw.focus()},60);
  });

  var m=document.getElementById('authModal');
  if(!m)return;
  var close=function(){m.hidden=true};
  var go=function(){
    var b=document.getElementById('authGo');
    b.disabled=true;b.textContent='Проверяем…';
    document.getElementById('authErr').textContent='';
    fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('authPw').value})})
      .then(function(r){return r.status===403?r.json().then(function(j){throw new Error(j.error||'неверный пароль')}):r.json()})
      .then(function(j){
        if(!j.ok)throw new Error(j.error||'неверный пароль');
        location.reload();
      })
      .catch(function(e){
        b.disabled=false;b.textContent='Войти';
        document.getElementById('authErr').textContent=e.message;
      });
  };
  document.getElementById('authGo').addEventListener('click',go);
  document.getElementById('authPw').addEventListener('keydown',function(e){if(e.key==='Enter')go()});
  document.getElementById('authCancel').addEventListener('click',close);
  m.addEventListener('click',function(e){if(e.target===m)close()});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!m.hidden)close()});
}

/* кнопка-действие владельца: гостю — блокировка с подсказкой, владельцу — свободно */
function lockGuest(sel){
  var b=typeof sel==='string'?document.querySelector(sel):sel;
  if(!b)return false;
  if(OWNER)return true;
  b.disabled=true;b.classList.add('locked');
  b.title='Доступно владельцу — ключ в шапке';
  return false;
}

/* высота плавучего острова: от неё отталкиваются липкие thead и нав-пилюля лаборатории */
function setHH(){
  var h=document.querySelector('header.top');
  if(h)document.documentElement.style.setProperty('--hh',(h.offsetHeight+2)+'px');
}
window.addEventListener('resize',setHH);
setHH();
