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

/* ============== C3: детектор, фальсификации, комитет ============== */
var VERDICT_TXT={beta_move:['β-движение','d'],idiosyncratic_temporary:['идио-шум','y'],thesis_damage:['ТЕЗИС ПОВРЕЖДЁН','r']};
function renderDetector(D){
  var sub=$('#detSub');
  if(!D.verdicts||!D.verdicts.length){sub.textContent='аномалий |r| > 2.5σ нет'+(D.cached?' · кэш':'');$('#detCard').innerHTML='<div class="cs mut">Просмотрено '+D.flagsChecked+' позиций — факторные остатки в норме.</div>';return}
  sub.textContent=D.verdicts.length+' аномалий · cooldown 7 дн';
  $('#detCard').innerHTML=D.verdicts.map(function(v){
    var vt=VERDICT_TXT[v.verdict]||['?','d'];
    var news=(v.news||[]).slice(0,3).map(function(n){return '<a href="'+esc(n.link||'#')+'" target="_blank" rel="noopener">'+esc(n.title)+'</a>'}).join('<br>');
    var fil=(v.filings||[]).slice(0,3).map(function(f){return '<a href="'+esc(f.url)+'" target="_blank" rel="noopener">'+f.form+' · '+esc(f.date)+'</a>'}).join('<br>');
    return '<div class="det-card">'
      +'<div class="det-h"><b>'+v.t+'</b>'
      +'<span class="pill '+vt[1]+'">'+vt[0]+'</span>'
      +'<span class="det-sig">'+n2(v.lastSigma)+'σ / '+n2(v.cumSigma)+'σ (5д)</span></div>'
      +'<div class="det-reason">'+esc(v.reason)+'</div>'
      +(v.pillar&&v.pillar!=='—'?'<div class="det-pillar">опора: '+esc(v.pillar)+'</div>':'')
      +'<div class="det-conf mut">уверенность '+((v.confidence==null)?'—':(v.confidence*100).toFixed(0)+'%')+(v.cooledDown?' · cooldown':'')+'</div>'
      +(news?'<div class="det-src">новости: '+news+'</div>':'')
      +(fil?'<div class="det-src">SEC: '+fil+'</div>':'')
      +'</div>';
  }).join('');
}

function renderFalsify(D){
  var items=D.items||[];
  $('#falSub').textContent=items.length+' записей';
  var rows=items.map(function(r){
    var last=r.checks&&r.checks.length?r.checks[r.checks.length-1]:null;
    var st=r.status==='triggered'?'<span class="pill r">ТРИГГЕР '+new Date(r.triggeredAt).toLocaleDateString('ru-RU')+'</span>'
      :r.status==='retired'?'<span class="pill d">снят</span>':'<span class="pill g">активна</span>';
    var conds=r.conditions.map(function(c,i){
      var vd=last?(last.verdicts||[]).find(function(x){return x.i===i}):null;
      return '<li>'+esc(c.text)+(vd?' — '+(vd.triggered?'<b class="dn">сработало</b>':esc(vd.evidence)):'')+'</li>';
    }).join('');
    return '<div class="fal-card"><div class="det-h"><b>'+r.t+'</b>'+st
      +(last?'<span class="det-sig mut">чек '+new Date(last.date).toLocaleDateString('ru-RU')+'</span>':'<span class="det-sig mut">ещё не проверялась</span>')
      +'</div><div class="det-reason">тезис: '+esc(r.thesis)+'</div><ol class="fal-conds">'+conds+'</ol>'
      +'<button class="lab-btn" data-fal-check="'+r.t+'">Проверить</button></div>';
  }).join('');
  $('#falCard').innerHTML=(rows||'<div class="cs mut">Реестр пуст — сгенерируй фальсификации для позиции.</div>')
    +'<div class="fal-new"><input id="falTicker" placeholder="ТИКЕР (напр. TSM)" maxlength="8">'
    +'<button class="lab-btn" id="falGen">Сгенерировать 3 условия</button></div>';
  var genBtn=$('#falGen');
  if(genBtn)genBtn.addEventListener('click',function(){
    genBtn.disabled=true;genBtn.textContent='Генерируем…';
    post('/api/lab/falsify',{action:'generate',t:($('#falTicker').value||'').trim().toUpperCase()})
      .then(function(){location.reload()}).catch(function(e){alert(e.message);genBtn.disabled=false;genBtn.textContent='Сгенерировать 3 условия'});
  });
  $$('#falCard [data-fal-check]').forEach(function(b){
    b.addEventListener('click',function(){
      b.disabled=true;b.textContent='Проверяем…';
      post('/api/lab/falsify',{action:'check',t:b.dataset.falCheck})
        .then(function(){location.reload()}).catch(function(e){alert(e.message);b.disabled=false;b.textContent='Проверить'});
    });
  });
}

function post(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){if(!j.ok)throw new Error(j.error||'ошибка');return j})}

var ROLENAME={bull:'Бык',bear:'Медведь',devil:'Адвокат дьявола',baserates:'Базовые ставки'};
function evTxt(e){
  if(!e)return '—';
  var h=e.horizon_days+' дн';
  if(String(e.kind).indexOf('price_')===0)return e.t+' '+(e.kind==='price_above'?'+':'−')+(e.x*100).toFixed(0)+'% за '+h;
  if(String(e.kind).indexOf('index_')===0)return 'S&P '+(e.kind==='index_above'?'+':'−')+(e.x*100).toFixed(0)+'% за '+h;
  return 'VIX '+(e.kind==='vix_above'?'≥':'≤')+e.level+' за '+h;
}
function renderCommittee(D){
  var w=D.weights||{},b=D.brier||{};
  $('#comSub').textContent=D.predictions?D.predictions.length+' последних прогнозов':'';
  var roleRow=D.roles.map(function(r){
    var br=b[r.id],wt=w[r.id];
    return '<div class="mc-row"><span>'+esc(r.name)+(wt!=null?' · вес '+(wt*100).toFixed(0)+'%':'')+'</span>'
      +'<b>'+(br==null?'нет оценённых':'Brier '+br.toFixed(3))+'</b></div>';
  }).join('');
  var cal=(D.calibration||[]).filter(function(x){return x.n>0}).map(function(x){
    return '<div class="mc-row"><span>заявлено '+(x.claimed*100).toFixed(0)+'%</span><b>факт '+(x.hitRate*100).toFixed(0)+'% · n='+x.n+'</b></div>';
  }).join('');
  var preds=(D.predictions||[]).slice(0,15).map(function(p){
    return '<div class="mc-row"><span>'+esc(ROLENAME[p.role]||p.role)+' · '+esc(evTxt(p.event))+'</span>'
      +'<b>'+(p.prob*100).toFixed(0)+'%'
      +(p.outcome==null?' <i class="mut">ждёт</i>':(p.outcome?' <i class="up">✓</i>':' <i class="dn">✗</i>'))+'</b></div>';
  }).join('');
  $('#comCard').innerHTML='<div class="mc-grid"><div><div class="ph">Калибровка ролей (Brier ↓)</div>'+roleRow
    +'<div class="ph" style="margin-top:12px">Бакеты вероятностей</div>'+(cal||'<div class="cs mut">пока нет созревших</div>')
    +'<div style="margin-top:14px"><button class="lab-btn" id="comRun">Созвать комитет</button> '
    +'<button class="lab-btn" id="comScore">Оценить созревшие</button></div></div>'
    +'<div><div class="ph">Последние прогнозы</div>'+(preds||'<div class="cs mut">Комитет ещё не созывался.</div>')+'</div></div>';
  var run=$('#comRun');
  if(run)run.addEventListener('click',function(){
    run.disabled=true;run.textContent='Комитет думает…';
    post('/api/lab/committee',{action:'run'}).then(function(){location.reload()}).catch(function(e){alert(e.message);run.disabled=false;run.textContent='Созвать комитет'});
  });
  var sc=$('#comScore');
  if(sc)sc.addEventListener('click',function(){
    sc.disabled=true;sc.textContent='Оцениваем…';
    post('/api/lab/committee',{action:'score'}).then(function(){location.reload()}).catch(function(e){alert(e.message);sc.disabled=false;sc.textContent='Оценить созревшие'});
  });
}

fetch('/api/lab/detector').then(function(r){return r.json()}).then(renderDetector).catch(function(e){$('#detSub').textContent='ошибка: '+e.message});
fetch('/api/lab/falsify').then(function(r){return r.json()}).then(renderFalsify).catch(function(e){$('#falSub').textContent='ошибка: '+e.message});
fetch('/api/lab/committee').then(function(r){return r.json()}).then(renderCommittee).catch(function(e){$('#comSub').textContent='ошибка: '+e.message});

/* ============== журнал: контрфактуалы (#6) ============== */
function cls2(v){return v==null?'mut':(v>=0?'up':'dn')}
function renderCF(D){
  var items=D.items||[], adv=D.advice;
  $('#cfSub').textContent=items.length+' решений старше 30 дн'+(adv&&adv.n?' · советов оценено: '+adv.n:'');
  if(!items.length&&!adv){
    $('#cfTable').innerHTML='<tbody><tr><td class="cs" style="padding:12px 4px;color:var(--ink3)">Решений пока нет. Кнопка «Записать решение» — внизу главного терминала; сделки из Tradernet подхватываются сами.</td></tr></tbody>';
    return;
  }
  var rows=items.map(function(x){
    return '<tr><td class="tk">'+x.t+'</td><td>'+x.type+'</td>'
      +'<td class="num '+cls2(x.actualPct)+'">'+n2(x.actualPct)+'%</td>'
      +'<td class="num '+cls2(x.alternativePct)+'">'+n2(x.alternativePct)+'%</td>'
      +'<td class="num '+cls2(x.edgePct)+'">'+n2(x.edgePct)+'%</td>'
      +'<td class="nt">'+esc(x.alternativeLabel||'')+'</td></tr>';
  }).join('');
  var advRow=adv&&adv.n
    ?'<tr><td class="tk">Σ</td><td>советы</td><td class="num mut">—</td><td class="num mut">—</td>'
     +'<td class="num '+cls2(-adv.meanRet)+'">'+(adv.hits+'/'+adv.n)+'</td>'
     +'<td class="nt">детектор thesis_damage: средний ход после −'+n2(adv.meanRet)+'%</td></tr>'
    :'';
  $('#cfTable').innerHTML='<thead><tr><th>Тикер</th><th>Тип</th><th class="num">Факт</th><th class="num">Альтернатива</th><th class="num">Преимущество</th><th>Альтернатива — что это</th></tr></thead><tbody>'+rows+advRow+'</tbody>';
}
fetch('/api/lab/counterfactuals').then(function(r){return r.json()}).then(renderCF).catch(function(e){$('#cfSub').textContent='ошибка: '+e.message});

/* ============== базовые ставки (#7) ============== */
var BR_CLASS={drawdown40:'просадка ≥40% от 52-нед максимума',shock15:'шок-день ≤ −15%'};
function renderBR(D){
  var d=D.data;
  if(!d){$('#brSub').textContent='нет данных — нужен бэкфилл';$('#brCard').innerHTML='<div class="cs mut">Нажми «Бэкфилл вселенной»: загрузит 10 лет истории S&P 500 (~500 тикеров, несколько минут).</div><div style="margin-top:12px"><button class="lab-btn" id="brBackfill">Бэкфилл вселенной</button></div>';hookBR();return}
  $('#brSub').textContent='S&P 500 · '+d.loaded+'/'+d.universe+' тикеров · '+new Date(d.generatedAt).toLocaleDateString('ru-RU');
  var rows=Object.keys(BR_CLASS).map(function(cls){
    var a=d.agg[cls]; if(!a)return '';
    return '<div class="mc-row"><span>'+BR_CLASS[cls]+' · n='+a.n+'</span>'
      +'<b>1м '+n2(a.medianFwd[0])+'% · 3м '+n2(a.medianFwd[1])+'% · 6м '+n2(a.medianFwd[2])+'% · 12м '+n2(a.medianFwd[3])+'%'
      +(a.recoveredShare!=null?' · восст '+(a.recoveredShare*100).toFixed(0)+'%':'')+'</b></div>';
  }).join('');
  $('#brCard').innerHTML='<div class="lab-warn">Эмпирика по сегодняшним живым участникам индекса — survivorship bias: исключённые из индекса компании не видны, реальные исходы хуже показанных.</div>'
    +rows
    +'<div class="ph" style="margin-top:14px">Запрос: что обычно происходит после…</div>'
    +'<div class="fal-new"><input id="brQ" placeholder="напр.: срез гайденса дважды + инсайдеры покупают" style="width:340px">'
    +'<button class="lab-btn" id="brAsk">Спросить</button></div>'
    +'<div id="brAns" style="margin-top:10px"></div>';
  hookBR();
}
function hookBR(){
  var bf=$('#brBackfill');
  if(bf)bf.addEventListener('click',function(){
    bf.disabled=true;bf.textContent='Бэкфилл идёт (минуты)…';
    fetch('/api/lab/baserates?backfill=1').then(function(r){return r.json()}).then(function(j){
      if(!j.ok)throw new Error(j.error);
      location.reload();
    }).catch(function(e){alert(e.message);bf.disabled=false;bf.textContent='Бэкфилл вселенной'});
  });
  var ask=$('#brAsk');
  if(ask)ask.addEventListener('click',function(){
    var q=($('#brQ').value||'').trim(); if(!q)return;
    ask.disabled=true;ask.textContent='…';
    fetch('/api/lab/baserates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:q})})
      .then(function(r){return r.json()}).then(function(j){
        if(!j.ok)throw new Error(j.error);
        var res=j.result, emp=res.empirical, pr=res.llmPrior;
        $('#brAns').innerHTML='<div class="det-card">'
          +'<div class="det-h"><b>класс: '+esc(res.classification)+'</b></div>'
          +(emp?'<div class="det-reason">Эмпирика (S&P 500, '+emp.n+' событий): медиана 12м <b>'+n2(emp.medianFwd[3])+'%</b> (квартили '+n2(emp.q1Fwd[3])+'…'+n2(emp.q3Fwd[3])+'%), восстановились за год '+(emp.recoveredShare!=null?(emp.recoveredShare*100).toFixed(0)+'%':'—')+' · <i>survivorship-biased</i></div>':'<div class="det-reason mut">Для этого класса эмпирики нет — только мнение модели.</div>')
          +'<div class="det-reason">Приор модели (МНЕНИЕ, не данные): '+esc(pr.note)+' · медиана 12м ~'+n2(pr.median12m)+'%</div>'
          +'</div>';
        ask.disabled=false;ask.textContent='Спросить';
      }).catch(function(e){alert(e.message);ask.disabled=false;ask.textContent='Спросить'});
  });
}
fetch('/api/lab/baserates').then(function(r){return r.json()}).then(renderBR).catch(function(e){$('#brSub').textContent='ошибка: '+e.message});

/* ============== капитальный цикл (#8) ============== */
function renderCC(D){
  var d=D.data;
  $('#ccSub').textContent='композит z='+n2(d.composite)+' · стадия: '+esc(d.stageLabel)+(D.cached?' · кэш':'');
  var legs=Object.keys(d.legs).map(function(k){
    var z=d.legs[k];
    return '<div class="mc-row"><span>'+esc(k)+'</span><b class="'+(z>=0?'up':'dn')+'">z '+n2(z)+'</b></div>';
  }).join('');
  var capex=d.capex.companies.map(function(c){
    return '<div class="mc-row"><span>'+c.t+'</span><b>'+(c.growth!=null?('TTM капекс '+(c.ttm/1e9).toFixed(1)+'$ млрд · г/г '+(c.growth>=0?'+':'')+n2(c.growth)+'%'):('ошибка: '+esc(c.error||'')))+'</b></div>';
  }).join('');
  var ks=d.killSwitch&&d.killSwitch.count>=2
    ?'<div class="lab-warn">kill-switch зона: '+d.killSwitch.count+' из 3 ног в сжатии ('+esc(d.killSwitch.legs.join(', '))+')</div>':'';
  var gpu=d.gpuRent
    ?'<div class="mc-row"><span>аренда GPU (ручной ввод)</span><b>$'+n2(d.gpuRent.usdPerGpuHour)+'/GPU·ч от '+new Date(d.gpuRent.date).toLocaleDateString('ru-RU')+'</b></div>'
    :'';
  $('#ccCard').innerHTML='<div class="mc-grid"><div><div class="ph">Ноги композита (z за 60 дн)</div>'+legs+ks
    +'<div class="ph" style="margin-top:12px">Капекс гиперскейлеров (XBRL EDGAR, FY)</div>'+capex
    +(d.capex.avgGrowth!=null?'<div class="mc-row"><span>средний рост</span><b>'+(d.capex.avgGrowth>=0?'+':'')+n2(d.capex.avgGrowth)+'%</b></div>':'')
    +'<div class="ph" style="margin-top:12px">Аренда GPU — ручной слот</div>'+gpu
    +'<div class="fal-new"><input id="gpuIn" type="number" min="0" step="0.01" placeholder="$/GPU·ч, напр. 2.10" style="width:170px"><button class="lab-btn" id="gpuBtn">Записать</button></div>'
    +'</div><div><div class="ph">История композита по месяцам</div>'
    +d.history.map(function(h){
      return '<div class="mc-row"><span>'+h.month+'</span><b>z '+n2(h.composite)+' · '+['сжатие','охлаждение','расширение','перегрев'][h.stage]+'</b></div>';
    }).join('')
    +'<div class="cs mut" style="margin-top:8px">Стадия — прокси спроса по рыночным рядам; капекс — факт из отчётов. Ручной ввод аренды GPU дополняет картину, если есть источник.</div>'
    +'</div></div>';
  var g=$('#gpuBtn');
  if(g)g.addEventListener('click',function(){
    var v=+($('#gpuIn').value||0); if(!(v>0)){alert('введи цену');return}
    g.disabled=true;
    fetch('/api/lab/capcycle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'gpu',usd:v})})
      .then(function(r){return r.json()}).then(function(j){ if(!j.ok)throw new Error(j.error); location.reload(); })
      .catch(function(e){alert(e.message);g.disabled=false});
  });
}
fetch('/api/lab/capcycle').then(function(r){return r.json()}).then(renderCC).catch(function(e){$('#ccSub').textContent='ошибка: '+e.message});
