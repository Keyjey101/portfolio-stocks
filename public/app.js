'use strict';
/* ───────────── утилиты ───────────── */
var $=function(s){return document.querySelector(s)};
var $$=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
var REDUCED=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var COL={g:'#0e8a5f',y:'#a97b10',o:'#c0621c',r:'#c43d33',d:'#757b80'};
var TAGCOL={core:'#b3801f',real:'#587fa8',quality:'#8a6ba8',lotto:'#c05e6e',exit:'#757b80',index:'#3e948f'};
var TAGNAME={core:'AI-ядро',real:'Реальные активы',quality:'Quality',lotto:'Лотереи',exit:'На выход',index:'Индекс'};
var TAGORDER=['core','real','quality','lotto','exit','index'];
var REFRESH_MS=90000, RING_C=56.55;

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function n(v,d){d=d==null?2:d;return v==null?'—':Number(v).toFixed(d)}
function sign(v){return v==null?'—':(v>=0?'+':'')+v.toFixed(1)+'%'}
function money(v){return '$'+Math.round(v).toLocaleString('ru-RU')}
function smoney(v){return (v>=0?'+':'−')+money(Math.abs(v))}
function cls(v){return v==null?'mut':(v>=0?'up':'dn')}

function sparkSvg(vals,w,h,t){
  if(!vals||vals.length<2)return '';
  w=w||150;h=h||34;
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);
  if(mx-mn<1e-9){mx=mn+1}
  var pad=2,i,pts=[];
  for(i=0;i<vals.length;i++){
    pts.push((pad+(w-2*pad)*i/(vals.length-1)).toFixed(1)+','+(h-pad-(h-2*pad)*(vals[i]-mn)/(mx-mn)).toFixed(1));
  }
  var up=vals[vals.length-1]>=vals[0],c=up?COL.g:COL.r;
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" data-s="'+JSON.stringify(vals)+'"'+(t?' data-t="'+t+'"':'')+'>'
    +'<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+c+'" stroke-width="1.5" stroke-opacity=".85" stroke-linejoin="round" stroke-linecap="round"/>'
    +'</svg>';
}

function animateNum(el,target,fmt){
  if(REDUCED||!el){el.textContent=fmt(target);return}
  var t0=null,dur=1000;
  function step(ts){
    if(!t0)t0=ts;
    var p=Math.min((ts-t0)/dur,1),e=1-Math.pow(1-p,4);
    el.textContent=fmt(target*e);
    if(p<1)requestAnimationFrame(step);else el.textContent=fmt(target);
  }
  requestAnimationFrame(step);
}

/* ───────────── тосты ───────────── */
function toast(msg,type){
  var t=document.createElement('div');
  t.className='toast';t.style.setProperty('--tc',COL[type]||'#8f6a1e');
  t.textContent=msg;$('#toasts').appendChild(t);
  setTimeout(function(){t.classList.add('out');setTimeout(function(){t.remove()},330)},3600);
}

/* ───────────── загрузка ───────────── */
var bootStages=[
  {p:22,s:'Запрашиваем позиции: Tradernet API…'},
  {p:52,s:'Запрос котировок: 40+ тикеров…'},
  {p:78,s:'Расчёт сигналов и уровней докупа…'},
  {p:93,s:'Полируем серебро…'}
];
var bootStepsDef=[['Позиции',25],['Котировки',55],['Сигналы',80],['Готово',97]];

function initBootSteps(){
  $('#bootSteps').innerHTML=bootStepsDef.map(function(s){
    return '<span class="step" data-th="'+s[1]+'">'+s[0]+'</span>';
  }).join('');
}
function bootProgress(p){
  $('#bootFill').style.width=p+'%';
  $$('#bootSteps .step').forEach(function(el){
    var th=+el.dataset.th;
    el.classList.toggle('on',p>=th*0.45&&p<th);
    el.classList.toggle('done',p>=th);
  });
}
var bootTimers=[];
function playBoot(){
  bootTimers.forEach(clearTimeout);bootTimers=[];
  bootStages.forEach(function(st,k){
    bootTimers.push(setTimeout(function(){
      bootProgress(st.p);$('#bootStatus').textContent=st.s;
    },400+k*650));
  });
  bootTimers.push(setTimeout(startFun,400+bootStages.length*650));
}

var FUN_MSGS=[
  'Протираем приборы замшей…',
  'Настраиваем блики на серебре…',
  'Считаем чужие деньги…',
  'Разливаем DCA по стаканам…',
  'Просим VIX взять себя в руки…',
  'Проверяем уровни докупа строительным уровнем…',
  'Размораживаем котировки…',
  'Ждём, пока 10Y договорится сама с собой…',
  'Сверяем часы с Уолл-стрит…',
  'Ищем, где спрятался резерв…',
  'Обметаем пыль с 200-дневной средней…',
  'Уговариваем Yahoo отвечать быстрее…',
  'Наливаем кофе аниматору загрузки…'
];
var funTimer=null,funI=0,funP=93;
function startFun(){
  stopFun();funI=0;funP=93;
  funTimer=setInterval(function(){
    funP=Math.min(funP+0.2+Math.random()*0.35,99.2);
    bootProgress(funP);
    var st=$('#bootStatus');
    st.textContent=FUN_MSGS[funI%FUN_MSGS.length];funI++;
    st.classList.remove('tick');void st.offsetHeight;st.classList.add('tick');
  },850);
}
function stopFun(){if(funTimer){clearInterval(funTimer);funTimer=null}}

function boot(){
  var b=$('#boot');b.classList.remove('hide','err');
  initBootSteps();playBoot();
  fetch('/api/data').then(function(r){
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(D){
    bootTimers.forEach(clearTimeout);stopFun();
    bootProgress(100);$('#bootStatus').textContent='Готово';
    if(D.posSource!=='api')toast('Позиции из кэша — Tradernet API недоступен (включи VPN или задай TRADERNET_PROXY)','o');
    setTimeout(function(){
      DATA=D;renderAll();
      document.body.classList.add('ready');
      b.classList.add('hide');
      startRing();
    },420);
  }).catch(function(e){
    bootTimers.forEach(clearTimeout);stopFun();
    $('#bootErr').textContent='Ошибка: '+e.message+'. Проверь интернет и Node 18+.';
    b.classList.add('err');
    $('#bootStatus').textContent='Сбой загрузки';
  });
}
$('#bootRetry').addEventListener('click',boot);

/* ───────────── рендер ───────────── */
var DATA=null,prevPx={};

function setMood(c){
  document.body.dataset.mood=c||'d';
  var led=$('#moodLed');
  if(led)led.style.setProperty('--cc',COL[c]||'#8f6a1e');
}

function renderTape(D){
  var rs=D.rows.filter(function(r){return r.ok}).slice();
  rs.sort(function(a,b){return Math.abs(b.day||0)-Math.abs(a.day||0)});
  var items=rs.map(function(r){
    return '<span class="ti"><b>'+r.t+'</b>'+n(r.px)+'<i class="'+cls(r.day)+'">'+sign(r.day)+'</i></span>';
  }).join('');
  $('#tapeTrack').innerHTML=items+items;
}

/* агрегаты портфеля по строкам */
function totals(D){
  var cost=0,pnl=0,day=0,cnt=0;
  D.rows.forEach(function(r){
    if(!r.ok)return;
    cnt++;
    if(r.avg>0&&r.qty>0){cost+=r.avg*r.qty;pnl+=(r.px-r.avg)*r.qty}
    if(r.day!=null&&r.val)day+=r.val*r.day/(100+r.day);
  });
  return {cost:cost,pnl:pnl,day:day,cnt:cnt};
}

function renderMast(D){
  var t=totals(D);
  animateNum($('#heroVal'),D.total,money);

  var dayPct=t.day!==0&&D.total? t.day/(D.total-t.day)*100 : 0;
  var pnlPct=t.cost>0? t.pnl/t.cost*100 : null;
  $('#heroChips').innerHTML=
    '<span class="hchip"><small>день</small><b class="'+cls(t.day)+'">'+smoney(t.day)+' · '+sign(dayPct)+'</b></span>'
    +(pnlPct!=null?'<span class="hchip"><small>P&amp;L</small><b class="'+cls(t.pnl)+'">'+smoney(t.pnl)+' · '+sign(pnlPct)+'</b></span>':'')
    +'<span class="hchip"><small>вложено</small><b>'+money(t.cost)+'</b></span>';

  var share=D.total>0?D.cash/(D.total+D.cash)*100:0;
  $('#heroSub').innerHTML='<b>'+t.cnt+'</b> позиций · кэш <b>'+money(D.cash)+'</b> · '+n(share,1)+'% (цель 10%) · '+(D.posSource==='api'?'позиции — Tradernet API':'позиции — кэш, API недоступен');

  var v=D.verdict,vc=COL[v.c]||'#8f6a1e';
  var box=$('#verdict');
  box.style.setProperty('--vc',vc);
  var dots=(v.fires||[]).map(function(f){return '<i class="'+(f.fires?'on':'')+'"></i>'}).join('');
  box.innerHTML='<div class="v-eyebrow"><i class="led"></i>Решение системы</div>'
    +'<div class="v-big">'+esc(v.t)+'</div>'
    +(dots?'<div class="v-dots">'+dots+'</div>':'')
    +'<div class="v-sub"><b>'+(v.n!=null?v.n:'?')+' / 3</b> сигналов сработало</div>';
}

function renderSig(D){
  if(!D.verdict.fires||!D.verdict.fires.length){$('#vbreakSec').classList.add('hide');return}
  $('#vbreakSec').classList.remove('hide');
  $('#vbreak').innerHTML=D.verdict.fires.map(function(f){
    var near=!f.fires&&f.prog>=0.85;
    return '<div class="vchip '+(f.fires?'on':'')+'">'
      +'<div class="vh"><span class="vii">'+(f.fires?'✓':'○')+'</span>'+esc(f.name)+'</div>'
      +'<div class="vnow">'+esc(f.now)+'</div>'
      +'<div class="vneed">'+esc(f.need)+'</div>'
      +'<div class="vbar"><i data-w="'+Math.round(f.prog*100)+'"></i></div>'
      +(near?'<div class="vnear">≈ на границе — вердикт может переключаться</div>':'')
      +'</div>';
  }).join('');
  setTimeout(function(){$$('.vbar i').forEach(function(el){el.style.width=el.dataset.w+'%'})},250);
}

function renderAll(){
  var D=DATA;
  $('#stamp').textContent='обновлено '+new Date(D.generatedAt).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

  setMood(D.verdict.c);
  renderTape(D);
  renderMast(D);
  renderSig(D);

  var t=totals(D);
  var share=D.total>0?D.cash/(D.total+D.cash)*100:0;
  var cards=[
    {id:'cV',t:'VIX · страх',v:D.vixV,f:function(x){return n(x,1)},c:D.sV.c,sub:D.sV.z+' — '+D.sV.txt,sp:D.vixSpark},
    {id:'cS',t:'S&P 500 · тренд',v:D.spxPx,f:function(x){return n(x,0)},c:D.sT.c,sub:D.sT.z+' · от пика '+n(D.sT.dd,1)+'% · 200MA '+n(D.ma200,0),sp:D.spxSpark},
    {id:'cY',t:'10Y · за месяц',v:D.y10,f:function(x){return n(x,2)+'%'},c:D.sY.c,sub:D.sY.z+' '+(D.sY.chg>=0?'+':'')+n(D.sY.chg,0)+' б.п. — '+D.sY.txt,sp:D.tnxSpark},
    {id:'cP',t:'Резерв · кэш',v:D.cash,f:money,c:'d',sub:n(share,1)+'% от портфеля · цель 10%',goal:Math.min(share/10*100,100)}
  ];
  $('#cards').innerHTML=cards.map(function(c,i){
    return '<div class="card bez spot reveal" style="--d:'+(90+i*70)+'ms;--cc:'+COL[c.c]+'"><div class="core">'
      +'<div class="ct"><i class="led"></i>'+c.t+'</div><div class="cv" id="'+c.id+'">—</div>'
      +'<div class="cs">'+esc(c.sub)+'</div>'
      +(c.sp&&c.sp.length>2?'<div class="cspk">'+sparkSvg(c.sp,120,30)+'</div>':'')
      +(c.goal!=null?'<div class="goal"><i data-w="'+c.goal.toFixed(1)+'"></i></div>':'')
      +'</div></div>';
  }).join('');
  cards.forEach(function(c){animateNum($('#'+c.id),c.v||0,c.f)});
  setTimeout(function(){$$('.goal i').forEach(function(el){el.style.width=el.dataset.w+'%'})},200);

  renderSpx(D);
  renderDonut(D);
  renderGroups(D);
  renderWatch(D);

  var failed=D.rows.filter(function(r){return !r.ok});
  $('#failed').textContent=failed.length?'Не загрузились: '+failed.map(function(r){return r.t}).join(', '):'';

  attachSort();applyFilter();
}

function renderSpx(D){
  var v=D.spxSpark;
  if(!v||v.length<2){$('#spxChart .core').innerHTML='<div class="ph">S&P 500 · год</div><div class="cs">нет данных</div>';return}
  var w=560,h=150,pad=6,mn=Math.min.apply(null,v),mx=Math.max.apply(null,v);
  if(mx-mn<1e-9)mx=mn+1;
  var y=function(x){return h-pad-(h-2*pad)*(x-mn)/(mx-mn)};
  var pts=v.map(function(val,i){return[(pad+(w-2*pad)*i/(v.length-1)).toFixed(1),y(val).toFixed(1)]});
  var line=pts.map(function(p){return p.join(',')}).join(' ');
  var up=v[v.length-1]>=v[0],c=up?COL.g:COL.r;
  var last=y(v[v.length-1]).toFixed(1);
  var ma='';
  if(D.ma200&&D.ma200>=mn&&D.ma200<=mx){
    ma='<line x1="'+pad+'" x2="'+(w-pad)+'" y1="'+y(D.ma200).toFixed(1)+'" y2="'+y(D.ma200).toFixed(1)+'" stroke="#9aa0a5" stroke-width="1" stroke-dasharray="5 4"/>'
      +'<text x="'+(w-8)+'" y="'+(y(D.ma200)-5).toFixed(1)+'" text-anchor="end" fill="#757b80" font-size="9" font-family="IBM Plex Mono,monospace">200MA '+n(D.ma200,0)+'</text>';
  }
  $('#spxChart .core').innerHTML='<div class="ph">S&P 500 · год <b>'+n(D.spxPx,0)+' · '+sign(D.sT.dd)+' от пика</b></div>'
    +'<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
    +'<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">'
    +'<stop offset="0" stop-color="'+c+'" stop-opacity=".16"/>'
    +'<stop offset="1" stop-color="'+c+'" stop-opacity="0"/></linearGradient></defs>'
    +'<polygon points="'+line+' '+(w-pad)+','+h+' '+pad+','+h+'" fill="url(#ag)"/>'
    +ma
    +'<polyline points="'+line+'" fill="none" stroke="'+c+'" stroke-width="1.8" stroke-linejoin="round"/>'
    +'<circle class="dot" cx="'+pts[pts.length-1][0]+'" cy="'+last+'" r="3" fill="'+c+'"/>'
    +'<text x="6" y="12" fill="#757b80" font-size="9" font-family="IBM Plex Mono,monospace">'+n(mx,0)+'</text>'
    +'<text x="6" y="'+(h-4)+'" fill="#757b80" font-size="9" font-family="IBM Plex Mono,monospace">'+n(mn,0)+'</text>'
    +'</svg>';
}

function renderDonut(D){
  var segs=TAGORDER.filter(function(t){return (D.byTag[t]||0)>0}).map(function(t){
    return{tag:t,v:D.byTag[t],c:TAGCOL[t]};
  });
  if(!segs.length||!D.total){$('#donutPanel .core').innerHTML='<div class="ph">Структура</div><div class="cs">нет данных</div>';return}
  var R=44,C=2*Math.PI*R,off=0,circles='',finals=[];
  segs.forEach(function(s,i){
    var frac=s.v/D.total;
    circles+='<circle class="dseg" data-i="'+i+'" cx="60" cy="60" r="'+R+'" fill="none" stroke="'+s.c
      +'" stroke-width="13" stroke-dasharray="0 '+C.toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)
      +'" transform="rotate(-90 60 60)" stroke-linecap="butt"/>';
    finals.push((frac*C-1.5).toFixed(2)+' '+C.toFixed(2));
    off+=frac*C;
  });
  $('#donutPanel .core').innerHTML='<div class="ph">Структура портфеля <b>'+money(D.total)+'</b></div>'
    +'<div class="donut-in">'
    +'<svg viewBox="0 0 120 120">'
    +'<circle cx="60" cy="60" r="'+R+'" fill="none" stroke="rgba(26,28,30,.07)" stroke-width="13"/>'
    +circles
    +'<text x="60" y="57" text-anchor="middle" fill="#1a1c1e" font-size="13" font-weight="600" font-family="IBM Plex Mono,monospace">'+money(D.total)+'</text>'
    +'<text x="60" y="72" text-anchor="middle" fill="#757b80" font-size="8" letter-spacing="1.5" font-family="IBM Plex Mono,monospace">ПОРТФЕЛЬ</text>'
    +'</svg>'
    +'<div class="dleg">'+segs.map(function(s){
      return '<div><i style="background:'+s.c+'"></i>'+TAGNAME[s.tag]
        +'<span class="dv"><b>'+money(s.v)+'</b> · '+(s.v/D.total*100).toFixed(1)+'%</span></div>';
    }).join('')+'</div></div>';
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      $$('.dseg').forEach(function(el){
        el.setAttribute('stroke-dasharray',finals[+el.dataset.i]);
      });
    });
  });
}

function rowHtml(r,tc,i){
  var d=i==null?'':(' style="animation-delay:'+Math.min(i*25,400)+'ms"');
  return '<tr data-t="'+r.t+'" data-q="'+esc((r.t+' '+(r.note||'')).toLowerCase())+'"'+d+'>'
    +'<td class="tk"><span class="dotc" style="--tc:'+tc+'"></span>'+r.t+'</td>'
    +'<td class="num" data-k="px" data-v="'+(r.px==null?'':r.px)+'">'+n(r.px)+'</td>'
    +'<td class="num '+cls(r.day)+'" data-k="day" data-v="'+(r.day==null?'-9999':r.day)+'">'+sign(r.day)+'</td>'
    +'<td class="num '+cls(r.pnl)+'" data-k="pnl" data-v="'+(r.pnl==null?'-9999':r.pnl)+'">'+sign(r.pnl)+'</td>'
    +'<td class="num" data-k="val" data-v="'+r.val+'">'+money(r.val)+'</td>'
    +'<td><span class="pill '+r.lvl.c+'">'+esc(r.lvl.s)+'</span></td>'
    +'<td class="spk">'+sparkSvg(r.sp,90,22,r.t)+'</td>'
    +'<td class="nt" title="'+esc(r.note||'')+'">'+esc(r.note||'')+'</td>'
    +'</tr>';
}

function renderGroups(D){
  var out='',gi=0;
  TAGORDER.forEach(function(tag){
    var rs=D.rows.filter(function(r){return r.tag===tag&&r.ok});
    if(!rs.length)return;
    rs.sort(function(a,b){return b.val-a.val});
    var sum=D.byTag[tag]||0,cost=0,pnl=0;
    rs.forEach(function(r){if(r.avg>0&&r.qty>0){cost+=r.avg*r.qty;pnl+=(r.px-r.avg)*r.qty}});
    var pnlStr=cost>0?' · <b class="'+cls(pnl)+'">'+smoney(pnl)+' ('+(pnl>=0?'+':'')+ (pnl/cost*100).toFixed(1)+'%)</b>':'';
    out+='<section class="grp reveal" data-tag="'+tag+'" style="--d:'+Math.min(120+gi*70,480)+'ms;--tc:'+TAGCOL[tag]+'">'
      +'<div class="gh"><h3>'+TAGNAME[tag]+'</h3><span class="pct">'+(sum/D.total*100).toFixed(1)+'% · '+money(sum)+pnlStr+'</span></div>'
      +'<div class="tw bez spot"><div class="core"><table><thead><tr>'
      +'<th data-k="t" class="sortable">Тикер<span class="arr"></span></th>'
      +'<th data-k="px" class="num sortable">Цена<span class="arr"></span></th>'
      +'<th data-k="day" class="num sortable">День<span class="arr"></span></th>'
      +'<th data-k="pnl" class="num sortable">P&amp;L<span class="arr"></span></th>'
      +'<th data-k="val" class="num sortable">$<span class="arr"></span></th>'
      +'<th>Статус</th><th>3 мес</th><th>Заметка</th>'
      +'</tr></thead><tbody>'+rs.map(function(r,i){return rowHtml(r,TAGCOL[tag],i)}).join('')+'</tbody></table></div></div>'
      +'</section>';
    gi++;
  });
  $('#groups').innerHTML=out;
}

function renderWatch(D){
  $('#watchBody').innerHTML=D.watch.filter(function(w){return w.ok}).map(function(w,i){
    return '<tr data-q="'+esc((w.t+' '+w.note).toLowerCase())+'" style="animation-delay:'+Math.min(i*40,200)+'ms">'
      +'<td class="tk"><span class="dotc" style="--tc:#8f6a1e"></span>'+w.t+'</td>'
      +'<td class="num" data-k="px" data-v="'+(w.px==null?'':w.px)+'">'+n(w.px)+'</td>'
      +'<td class="num '+cls(w.day)+'" data-k="day" data-v="'+(w.day==null?'-9999':w.day)+'">'+sign(w.day)+'</td>'
      +'<td class="spk">'+sparkSvg(w.sp,90,22,w.t)+'</td>'
      +'<td class="nt">'+esc(w.note)+'</td></tr>';
  }).join('');
}

/* ───────────── сортировка ───────────── */
function attachSort(){
  $$('.grp table, #watchSec table').forEach(function(tbl){
    var ths=tbl.querySelectorAll('th.sortable');
    ths.forEach(function(th){
      th.addEventListener('click',function(){
        var k=th.dataset.k,dir=th.dataset.dir==='asc'?'desc':'asc';
        ths.forEach(function(o){o.dataset.dir='';o.querySelector('.arr').textContent=''});
        th.dataset.dir=dir;th.querySelector('.arr').textContent=dir==='asc'?'▲':'▼';
        var tb=tbl.querySelector('tbody');
        var rows=Array.prototype.slice.call(tb.querySelectorAll('tr'));
        rows.sort(function(a,b){
          var ca=a.querySelector('[data-k="'+k+'"]'),cb=b.querySelector('[data-k="'+k+'"]');
          if(!ca||!cb)return 0;
          var va=ca.dataset.v,vb=cb.dataset.v;
          if(va===''||vb===''||va==null||vb==null){return String(va).localeCompare(String(vb))*(dir==='asc'?1:-1)}
          if(isNaN(+va)||isNaN(+vb)){return String(va).localeCompare(String(vb))*(dir==='asc'?1:-1)}
          return (+va-+vb)*(dir==='asc'?1:-1);
        });
        rows.forEach(function(r){
          r.style.animation='none';r.offsetHeight;r.style.animation='';
          r.style.animationDelay='0ms';
          tb.appendChild(r);
        });
        applyFilter();
      });
    });
  });
}

/* ───────────── поиск ───────────── */
var qEl=$('#q');
function applyFilter(){
  var q=(qEl.value||'').trim().toLowerCase();
  var any=false;
  $$('tbody tr').forEach(function(tr){
    var ok=!q||(tr.dataset.q||'').indexOf(q)>=0;
    tr.classList.toggle('hide',!ok);
    if(ok)any=true;
  });
  $$('.grp').forEach(function(sec){
    if(sec.id==='watchSec')return;
    var vis=sec.querySelectorAll('tbody tr:not(.hide)').length>0;
    var tagOk=!q||TAGNAME[sec.dataset.tag].toLowerCase().indexOf(q)>=0;
    sec.classList.toggle('hide',!(vis||tagOk));
  });
  var wv=$('#watchBody');
  if(wv)$('#watchSec').classList.toggle('hide',!Array.prototype.some.call(wv.querySelectorAll('tr'),function(tr){return !tr.classList.contains('hide')}));
  $('#noRes').classList.toggle('show',!any);
}
qEl.addEventListener('input',applyFilter);
qEl.addEventListener('keydown',function(e){if(e.key==='Escape'){qEl.value='';applyFilter();qEl.blur()}});

/* ───────────── автообновление ───────────── */
var endT=0,fetching=false;
function startRing(){endT=Date.now()+REFRESH_MS}
setInterval(function(){
  if(!DATA)return;
  if(document.hidden){endT=Math.max(endT,Date.now()+5000);return}
  var rem=endT-Date.now();
  $('#ringFg').style.strokeDashoffset=(RING_C*(1-Math.max(rem,0)/REFRESH_MS)).toFixed(2);
  if(rem<=0){startRing();refresh(true)}
},250);

function refresh(auto){
  if(fetching)return;
  fetching=true;
  var btn=$('#btnRefresh');btn.classList.add('spin');
  fetch('/api/data',{cache:'no-store'}).then(function(r){
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(D){
    prevPx={};
    if(DATA)DATA.rows.forEach(function(r){if(r.ok)prevPx[r.t]=r.px});
    DATA=D;renderAll();
    D.rows.forEach(function(r){
      if(r.ok&&prevPx[r.t]!=null&&Math.abs(prevPx[r.t]-r.px)>1e-9){
        var tr=document.querySelector('tr[data-t="'+r.t+'"]');
        if(tr){tr.classList.remove('flash-up','flash-dn');tr.offsetHeight;tr.classList.add(r.px>prevPx[r.t]?'flash-up':'flash-dn')}
      }
    });
    toast(auto?'Автообновление · данные свежие':'Данные обновлены','g');
  }).catch(function(e){
    toast('Ошибка обновления: '+e.message,'r');
  }).then(function(){
    fetching=false;btn.classList.remove('spin');startRing();
  });
}
$('#btnRefresh').addEventListener('click',function(){refresh(false)});

document.addEventListener('visibilitychange',function(){
  if(!document.hidden&&DATA&&Date.now()-new Date(DATA.generatedAt)>REFRESH_MS)refresh(true);
});
document.addEventListener('keydown',function(e){
  var tag=(e.target&&e.target.tagName)||'';
  if(e.key==='/'&&tag!=='INPUT'){e.preventDefault();qEl.focus()}
  if((e.key==='r'||e.key==='R'||e.key==='к'||e.key==='К')&&tag!=='INPUT'){refresh(false)}
});

/* ───────────── тултип спарклайна ───────────── */
var tipEl=null,xhLine=null,XNS='http://www.w3.org/2000/svg';
function tipHide(){
  if(tipEl)tipEl.style.display='none';
  if(xhLine)xhLine.style.display='none';
}
function tipMove(e){
  if(e.pointerType==='touch'){tipHide();return}
  var svg=e.target&&e.target.closest?e.target.closest('svg[data-s]'):null;
  if(!svg){tipHide();return}
  var vals;
  try{vals=JSON.parse(svg.dataset.s)}catch(err){tipHide();return}
  if(!vals||vals.length<2){tipHide();return}
  var rc=svg.getBoundingClientRect();
  var rel=Math.max(0,Math.min(1,(e.clientX-rc.left)/rc.width));
  var i=Math.round(rel*(vals.length-1));
  var v=vals[i],last=vals[vals.length-1];
  var html='<b>'+(svg.dataset.t?esc(svg.dataset.t)+' · ':'')+'$'+n(v)+'</b>';
  if(i===vals.length-1){
    html+='<span class="tipd mut">сейчас</span>';
  }else{
    var d=(v/last-1)*100;
    if(v===Math.min.apply(null,vals))html+='<span class="tipd dn">минимум</span>';
    else if(v===Math.max.apply(null,vals))html+='<span class="tipd up">максимум</span>';
    html+='<span class="tipd '+cls(d)+'">'+(d>=0?'+':'')+d.toFixed(1)+'% к тек.</span>';
  }
  tipEl.innerHTML=html;
  tipEl.style.display='block';
  var tw=tipEl.offsetWidth,th=tipEl.offsetHeight;
  var x=e.clientX+14;if(x+tw>window.innerWidth-8)x=e.clientX-tw-14;
  var y=e.clientY-th-10;if(y<8)y=e.clientY+16;
  tipEl.style.left=x+'px';tipEl.style.top=y+'px';
  if(!xhLine||xhLine.ownerSVGElement!==svg){
    xhLine=document.createElementNS(XNS,'line');
    xhLine.setAttribute('class','xh');
    xhLine.setAttribute('y1','0');
    xhLine.setAttribute('y2','100%');
    svg.appendChild(xhLine);
  }
  xhLine.style.display='';
  var xv=(rel*90).toFixed(1);
  xhLine.setAttribute('x1',xv);xhLine.setAttribute('x2',xv);
}
function initTip(){
  tipEl=document.getElementById('tip');
  if(!tipEl){tipEl=document.createElement('div');tipEl.id='tip';tipEl.setAttribute('aria-hidden','true');document.body.appendChild(tipEl)}
  document.addEventListener('pointermove',tipMove);
  document.addEventListener('pointerdown',function(e){if(e.pointerType==='touch')tipHide()});
  window.addEventListener('scroll',tipHide,{passive:true});
}
initTip();

/* ───────────── spotlight: кромка прибора светится под курсором ───────────── */
if(window.matchMedia&&matchMedia('(pointer:fine)').matches){
  document.addEventListener('pointermove',function(e){
    var el=e.target&&e.target.closest?e.target.closest('.spot'):null;
    if(!el)return;
    var r=el.getBoundingClientRect();
    el.style.setProperty('--mx',(e.clientX-r.left)+'px');
    el.style.setProperty('--my',(e.clientY-r.top)+'px');
  },{passive:true});
}

/* ───────────── высота острова для липких thead ───────────── */
function setHH(){
  var h=document.querySelector('header.top');
  if(h)document.documentElement.style.setProperty('--hh',(h.offsetHeight+2)+'px');
}
window.addEventListener('resize',setHH);
setHH();

boot();
