'use strict';
var $=function(s){return document.querySelector(s)};
var TAGNAME={core:'AI-ядро',real:'Реальные активы',quality:'Quality',lotto:'Лотереи',exit:'Выход',index:'Индекс'};
function n2(v){return v==null?'—':(v>=0?'':'−')+Math.abs(v).toFixed(2)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

fetch('/api/lab/factors').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(render).catch(function(e){$('#enbCard').textContent='Ошибка: '+e.message});

fetch('/api/lab/levels').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(renderLevels).catch(function(e){$('#levelsSub').textContent='ошибка: '+e.message});

function money(v){return '$'+Math.round(v).toLocaleString('ru-RU')}
function pct1(v){return v==null?'—':(v*100).toFixed(0)+'%'}

function renderLevels(D){
  if(!D.items||!D.items.length){$('#levelsSub').textContent='нет позиций с уровнями';return}
  $('#levelsSub').textContent='GARCH σ · P(касания за 12 мес)'+(D.cached?' · кэш':'');
  $('#levelsTable').innerHTML='<thead><tr><th>Тикер</th><th class="num">Цена</th><th class="num">σ год</th>'
    +'<th class="num">T1 · P</th><th class="num">T2 · P</th><th class="num">T3 · P</th><th>Флаги</th></tr></thead><tbody>'
    +D.items.map(function(it){
      var cells=[it.levels[0],it.levels[1],it.levels[2]].map(function(l){
        return l?'<td class="num"><b>'+l.v+'</b> · '+pct1(l.p)+'</td>':'<td class="num mut">—</td>';
      }).join('');
      var flags=[];
      if(it.fantasy)flags.push('<span class="dn">уровень-фантазия (P(T3)&lt;5%)</span>');
      if(it.merge&&it.merge.length)flags.push('<span class="oc">склеить: '+it.merge.map(function(p){return p[0]+'≈'+p[1]}).join(', ')+'</span>');
      if(it.waitCost!=null&&Math.abs(it.waitCost)>1)flags.push('<span class="mut">E[издержки ожидания] '+money(it.waitCost)+'/год на позицию (прокси)</span>');
      if(it.until)flags.push('<span class="mut">⏸ '+esc(it.until.event)+'</span>');
      return '<tr'+(it.fantasy?' class="odrv"':'')+'><td class="tk">'+it.t+'</td>'
        +'<td class="num">'+n2(it.px)+'</td><td class="num">'+(it.sigAnn*100).toFixed(0)+'%</td>'
        +cells+'<td class="nt">'+flags.join('<br>')+'</td></tr>';
    }).join('')+'</tbody>';
}

fetch('/api/lab/mc').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(renderMC).catch(function(e){$('#mcCard').textContent='Ошибка: '+e.message});

function renderMC(D){
  var P=D.params, B=D.base;
  $('#mcSub').textContent=P.years+' лет · '+money(P.monthlyUsd)+'/мес · старт '+money(P.startValue)+(D.cached?' · кэш':'');

  var rows=[['p5',B.terminal.p5],['p25',B.terminal.p25],['медиана',B.terminal.p50],['p75',B.terminal.p75],['p95',B.terminal.p95]];
  var sens=D.sens;
  var html='<div class="mc-grid"><div>'
    +'<div class="ph">Терминальный капитал</div>'
    +rows.map(function(r){return '<div class="mc-row"><span>'+r[0]+'</span><b>'+money(r[1])+'</b></div>'}).join('')
    +(P.target!=null?'<div class="mc-row"><span>P(≥ цели '+money(P.target)+')</span><b>'+pct1(D.targetProb)+'</b></div>':'')
    +'</div><div>'
    +'<div class="ph">Чувствительность к довнесениям (медиана)</div>'
    +'<div class="mc-row"><span>×0,5</span><b>'+money(sens.half.p50)+'</b></div>'
    +'<div class="mc-row"><span>×1</span><b>'+money(sens.base.p50)+'</b></div>'
    +'<div class="mc-row"><span>×2</span><b>'+money(sens.double.p50)+'</b></div>'
    +'<div class="mc-row mut"><span>всего довнесений</span><b>'+money(B.totalContrib)+'</b></div>'
    +'<div class="ph" style="margin-top:14px">Просадка (мес. срезы)</div>'
    +'<div class="mc-row"><span>медиана</span><b>'+(B.maxDD.p50*100).toFixed(0)+'%</b></div>'
    +'<div class="mc-row"><span>p95</span><b>'+(B.maxDD.p95*100).toFixed(0)+'%</b></div>'
    +'</div></div>'
    +'<div class="mc-fan">'+fanSvg(B.yearly,P.startValue,P.years)+'</div>'
    +'<div class="mc-states"><div class="ph">Режимы (HMM, '+D.nDays+' дней)</div>'
    +D.stateStats.map(function(s,i){
      return '<div class="mc-row"><span>режим '+(i+1)+' · '+(s.share*100).toFixed(0)+'% · '+s.days+' дн</span>'
        +'<b>VIX '+n2(s.vix)+' · 10Y '+(s.tnx20>=0?'+':'')+n2(s.tnx20)+' б.п. · SPX '+(s.spx20*100).toFixed(1)+'%</b></div>';
    }).join('')+'</div>';

  $('#mcCard').innerHTML=html;
}

function fanSvg(yearly,startValue,years){
  var W=640,H=200,pad=10;
  var bands=[['p5','p95',.10],['p25','p75',.20]];
  var all=[];
  yearly.forEach(function(q){all.push(q.p5,q.p95,q.p25,q.p75,q.p50)});
  var mn=Math.min.apply(null,all.concat([startValue])),mx=Math.max.apply(null,all);
  if(mx-mn<1e-9)mx=mn+1;
  var X=function(i){return pad+(W-2*pad)*i/years};
  var Y=function(v){return H-pad-(H-2*pad)*(v-mn)/(mx-mn)};
  var series=function(key){
    var pts=[[X(0)+','+Y(startValue)]];
    yearly.forEach(function(q,i){pts.push(X(i+1)+','+Y(q[key]))});
    return pts.join(' ');
  };
  var poly=function(a,b,op){
    var top=series(a).split(' '),bot=series(b).split(' ').reverse();
    return '<polygon points="'+top.concat(bot).join(' ')+'" fill="#8f6a1e" fill-opacity="'+op+'" stroke="none"/>';
  };
  return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:auto;display:block;margin-top:14px">'
    +poly('p5','p95','.08')+poly('p25','p75','.14')
    +'<polyline points="'+series('p50')+'" fill="none" stroke="#8f6a1e" stroke-width="2"/>'
    +'<text x="'+pad+'" y="12" fill="#757b80" font-size="9" font-family="IBM Plex Mono,monospace">'+money(mx)+'</text>'
    +'<text x="'+pad+'" y="'+(H-2)+'" fill="#757b80" font-size="9" font-family="IBM Plex Mono,monospace">'+money(mn)+'</text>'
    +'</svg>';
}

function render(D){
  $('#enbCard').innerHTML='<div class="enb-big">'+n2(D.enb)+'</div>'
    +'<div class="cs">'+D.tickers.length+' позиций → <b>'+n2(D.enb)+'</b> независимых ставок</div>'
    +'<div class="cs">Диверсификация DR: норма '+n2(D.normal.dr)+' · стресс '+n2(D.stress.dr)+'</div>'
    +(D.cached?'<div class="cs mut">кэш от '+new Date(D.generatedAt).toLocaleString('ru-RU')+'</div>':'');

  var tags=Object.keys(D.byTag);
  $('#expSub').textContent='портфель Σwᵢβᵢ · окно '+D.window+' д';
  $('#expTable').innerHTML='<thead><tr><th>Фактор</th><th class="num">Портфель β</th>'
    +tags.map(function(t){return '<th class="num">'+esc(TAGNAME[t]||t)+'</th>'}).join('')+'</tr></thead><tbody>'
    +D.factors.map(function(f){
      return '<tr><td class="tk">'+f+'</td><td class="num"><b>'+n2(D.exposure[f])+'</b></td>'
        +tags.map(function(t){return '<td class="num">'+n2((D.byTag[t]||{})[f])+'</td>'}).join('')+'</tr>';
    }).join('')+'</tbody>';

  $('#stressSub').textContent='стресс: SPY-день < −2% ('+D.stress.n+' дн) · норма: '+D.normal.n+' дн';
  if(D.stress.dr==null||!D.corrJump.length){
    $('#stressTable').innerHTML='<tbody><tr><td class="cs" style="padding:14px 4px;color:var(--ink3)">'
      +'Стресс-дней за год меньше 10 ('+D.stress.n+') — условные корреляции не рассчитываются: выборка нерепрезентативна.</td></tr></tbody>';
    return;
  }
  var warn=D.corrJump.some(function(c){return c.jump>0.2})
    ?'<div class="lab-warn">Диверсификация сжимается в стрессе: Δρ &gt; 0,2 у части позиций — «реальные активы» могут синхронизироваться с рынком</div>':'';
  $('#stressTable').innerHTML='<thead><tr><th>Тикер</th><th class="num">ρ норма</th><th class="num">ρ стресс</th><th class="num">Δρ</th></tr></thead><tbody>'
    +D.corrJump.map(function(c){
      return '<tr><td class="tk">'+c.t+'</td><td class="num">'+n2(D.normal.corr[c.t])+'</td>'
        +'<td class="num">'+n2(D.stress.corr[c.t])+'</td>'
        +'<td class="num '+(c.jump>0.2?'dn':(c.jump<-0.2?'up':''))+'">'+n2(c.jump)+'</td></tr>';
    }).join('')+'</tbody>'+warn;
}
