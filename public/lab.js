'use strict';
var $=function(s){return document.querySelector(s)};
var $$=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
var TAGNAME={core:'AI-ядро',real:'Реальные активы',quality:'Quality',lotto:'Лотереи',exit:'Выход',index:'Индекс'};
function n2(v){return v==null?'—':(v>=0?'':'−')+Math.abs(v).toFixed(2)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function take(txt,warn){return '<div class="takeaway'+(warn?' tk-warn':'')+'"><b>Вывод:</b> '+txt+'</div>'}

/* сессия: гость видит проценты, кнопки агентов — только владелец (сервер всё равно 401) */
initAuth(function(owner){
  if(owner)$$('.locked').forEach(function(el){el.disabled=false;el.classList.remove('locked');el.title=''});
});

fetch('/api/lab/factors').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(render).catch(function(e){$('#enbCard').textContent='Ошибка: '+e.message});

fetch('/api/lab/levels').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(renderLevels).catch(function(e){$('#levelsSub').textContent='ошибка: '+e.message});

function money(v){return '$'+Math.round(v).toLocaleString('ru-RU')}
function pct1(v){return v==null?'—':(v*100).toFixed(0)+'%'}

function renderLevels(D){
  if(!D.items||!D.items.length){$('#levelsSub').textContent='нет позиций с уровнями';return}
  var nFant=D.items.filter(function(i){return i.fantasy}).length;
  var nMerge=D.items.filter(function(i){return i.merge&&i.merge.length}).length;
  var nFrz=D.items.filter(function(i){return i.frozen}).length;
  var head=(nFant||nMerge||nFrz)
    ?take((nFant?'<b>'+nFant+'</b> уровней-фантазий (не дождёшься — пересмотри). ':'')+(nMerge?'у <b>'+nMerge+'</b> позиций уровни слиплись в один (спорить о $380 vs $370 — шум). ':'')+(nFrz?'<b>'+nFrz+'</b> позиций заморожены перед отчётом (T−7).':''),true)
    :take('все уровни реалистичны: вероятности касания в разумном диапазоне.');
  $('#levelsSub').textContent=GARCH_SUB(D);
  $('#levelsTable').innerHTML='<thead><tr><th>Тикер</th><th class="num">Цена</th><th class="num">σ год</th>'
    +'<th class="num">T1 · P</th><th class="num">T2 · P</th><th class="num">T3 · P</th><th>Флаги</th></tr></thead><tbody>'
    +'<tr><td colspan="7" style="padding:0 0 10px;border:none">'+head+'</td></tr>'
    +D.items.map(function(it){
      var cells=[it.levels[0],it.levels[1],it.levels[2]].map(function(l){
        return l?'<td class="num"><b>'+l.v+'</b> · '+pct1(l.p)+'</td>':'<td class="num mut">—</td>';
      }).join('');
      var flags=[];
      if(it.thesis)flags.push('<span class="mut">тезис: '+(STATE_META[it.thesis.state]?STATE_META[it.thesis.state][0]:it.thesis.state)+(it.thesis.conditional?' · уровни условные':'')+(it.thesis.basis?' — '+esc(it.thesis.basis):'')+'</span>');
      if(it.frozen)flags.push('<span class="oc">❄ заморожен до отчёта через '+it.frozen.days+' дн — полный транш запрещён</span>');
      if(it.fantasy)flags.push('<span class="dn">уровень-фантазия (P(T3)&lt;5%)</span>');
      if(it.suggest&&it.suggest.fantasy)flags.push('<span class="mut">замена: '+it.suggest.fantasy.level+' ('+it.suggest.fantasy.reason+')</span>');
      if(it.merge&&it.merge.length)flags.push('<span class="oc">склеить: '+it.merge.map(function(p){return p[0]+'≈'+p[1]}).join(', ')+'</span>');
      if(it.suggest&&it.suggest.merge)flags.push('<span class="mut">склеенная сетка: '+it.suggest.merge.grid.join(' / ')+'</span>');
      if(it.waitCost!=null&&Math.abs(it.waitCost)>1)flags.push('<span class="mut">E[издержки ожидания] '+money(it.waitCost)+'/год на позицию (прокси)</span>');
      if(it.until)flags.push('<span class="mut">ждёт: '+esc(it.until.event)+'</span>');
      return '<tr'+(it.fantasy?' class="odrv"':'')+'><td class="tk">'+it.t+'</td>'
        +'<td class="num">'+n2(it.px)+'</td><td class="num">'+(it.sigAnn*100).toFixed(0)+'%</td>'
        +cells+'<td class="nt">'+flags.join('<br>')+'</td></tr>';
    }).join('')+'</tbody>';
}
function GARCH_SUB(D){return 'P — вероятность касания за 12 мес'+(D.cached?' · кэш':'')}

fetch('/api/lab/mc').then(function(r){
    if(r.status===401)throw new Error('Монте-Карло — личный раздел (суммы довнесений и цель). Войди как владелец: ключ в шапке');
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  })
  .then(renderMC).catch(function(e){$('#mcCard').innerHTML='<div class="cs mut">'+esc(e.message)+'</div>';$('#mcSub').textContent='недоступно'});

function renderMC(D){
  var P=D.params, B=D.base;
  $('#mcSub').textContent=P.years+' лет · '+money(P.monthlyUsd)+'/мес · старт '+money(P.startValue)+(D.cached?' · кэш':'');
  var contribShare=P.startValue>0?B.totalContrib/(B.totalContrib+P.startValue):0;
  var head=take('через '+P.years+' лет медиана — <b>'+money(B.terminal.p50)+'</b>. Пессимистичный сценарий (5 из 100) — '+money(B.terminal.p5)+', оптимистичный — '+money(B.terminal.p95)+'. По пути будь готов к просадке ~'+(B.maxDD.p50*100).toFixed(0)+'% (в плохом случае '+(B.maxDD.p95*100).toFixed(0)+'%). Довнесения дадут ~'+(contribShare*100).toFixed(0)+'% итогового капитала — регулярность важнее выбора бумаг.');

  var rows=[['p5 — плохой расклад',B.terminal.p5],['p25',B.terminal.p25],['медиана',B.terminal.p50],['p75',B.terminal.p75],['p95 — отличный расклад',B.terminal.p95]];
  var sens=D.sens;
  var html=head+'<div class="mc-grid"><div>'
    +'<div class="ph">Итоговый капитал</div>'
    +rows.map(function(r){return '<div class="mc-row"><span>'+r[0]+'</span><b>'+money(r[1])+'</b></div>'}).join('')
    +(P.target!=null?'<div class="mc-row"><span>шанс достичь цели '+money(P.target)+'</span><b>'+pct1(D.targetProb)+'</b></div>':'')
    +'</div><div>'
    +'<div class="ph">Если менять довнесения (медиана)</div>'
    +'<div class="mc-row"><span>вдвое меньше</span><b>'+money(sens.half.p50)+'</b></div>'
    +'<div class="mc-row"><span>как сейчас ('+money(P.monthlyUsd)+'/мес)</span><b>'+money(sens.base.p50)+'</b></div>'
    +'<div class="mc-row"><span>вдвое больше</span><b>'+money(sens.double.p50)+'</b></div>'
    +'<div class="mc-row mut"><span>всего довнесешь за период</span><b>'+money(B.totalContrib)+'</b></div>'
    +'<div class="ph" style="margin-top:14px">Максимальная просадка</div>'
    +'<div class="mc-row"><span>обычный случай</span><b>'+(B.maxDD.p50*100).toFixed(0)+'%</b></div>'
    +'<div class="mc-row"><span>тяжёлый случай</span><b>'+(B.maxDD.p95*100).toFixed(0)+'%</b></div>'
    +'</div></div>'
    +'<div class="mc-fan">'+fanSvg(B.yearly,P.startValue,P.years)+'</div>'
    +'<div class="mc-states"><div class="ph">Режимы рынка, которые модель нашла в истории</div>'
    +D.stateStats.map(function(s,i){
      return '<div class="mc-row"><span>'+(s.vix<18?'спокойный':'тревожный')+' · '+(s.share*100).toFixed(0)+'% времени</span>'
        +'<b>VIX в среднем '+n2(s.vix)+'</b></div>';
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

var FACTOR_LABELS={SMH:'полупроводники',XLK:'технологии',URA:'уран',MOO:'агрохимия',GLD:'золото',XLE:'энергетика',IWM:'малая капитализация',TLT:'дюрация (ставки)',UUP:'валюта (доллар)',SPY:'рынок'};
function render(D){
  var topF=D.factors.map(function(f){return [f,Math.abs(D.exposure[f]||0)]}).sort(function(a,b){return b[1]-a[1]})[0];
  var sharePct=Math.round(100*D.enb/Math.max(1,D.tickers.length));
  $('#enbCard').innerHTML=take('из '+D.tickers.length+' позиций реально независимых — <b>'+n2(D.enb)+'</b> ('+sharePct+'%). Сильнейшая привязка портфеля — <b>'+topF[0]+'</b> (β '+n2(D.exposure[topF[0]])+'): если этот сектор качнётся, качнётся и портфель.')
    +'<div class="enb-big">'+n2(D.enb)+'</div>'
    +'<div class="cs">'+D.tickers.length+' позиций → <b>'+n2(D.enb)+'</b> независимых ставок</div>'
    +'<div class="cs">Диверсификация DR: норма '+n2(D.normal.dr)+' · стресс '+n2(D.stress.dr)+'</div>'
    +(D.cached?'<div class="cs mut">кэш от '+new Date(D.generatedAt).toLocaleString('ru-RU')+'</div>':'');

  var tags=Object.keys(D.byTag);
  $('#expSub').textContent='портфель Σwᵢβᵢ · окно '+D.window+' д';
  $('#expTable').innerHTML='<thead><tr><th>Фактор</th><th class="num">Портфель β</th>'
    +tags.map(function(t){return '<th class="num">'+esc(TAGNAME[t]||t)+'</th>'}).join('')+'</tr></thead><tbody>'
    +D.factors.map(function(f){
      return '<tr><td class="tk">'+f+' <i class="mut">'+esc(FACTOR_LABELS[f]||'')+'</i></td><td class="num"><b>'+n2(D.exposure[f])+'</b></td>'
        +tags.map(function(t){return '<td class="num">'+n2((D.byTag[t]||{})[f])+'</td>'}).join('')+'</tr>';
    }).join('')+'</tbody>';

  // #М6: ортогонализованные беты (Грам-Шмидт, рынок первым) — «чувствительность
  // сверх рыночной»; + R² и 95% CI по позициям
  var orthBox=$('#orthBox');
  if(orthBox&&D.orthOrder){
    var oo=D.orthOrder.filter(function(f){return f!=='SPY'});
    var orthRows=oo.map(function(f){
      return '<tr><td class="tk">'+f+' <i class="mut">'+esc(FACTOR_LABELS[f]||'')+'</i></td>'
        +'<td class="num"><b>'+n2((D.orthExposure||{})[f])+'</b></td>'
        +tags.map(function(t){return '<td class="num">'+n2(((D.orthByTag||{})[t]||{})[f])+'</td>'}).join('')+'</tr>';
    }).join('');
    $('#orthTable').innerHTML='<thead><tr><th>Фактор (за вычетом рынка)</th><th class="num">Портфель β</th>'
      +tags.map(function(t){return '<th class="num">'+esc(TAGNAME[t]||t)+'</th>'}).join('')+'</tr></thead><tbody>'+orthRows+'</tbody>';
    var aiNote=D.aiOrthSmh!=null
      ?'AI-ядро, β к орто-SMH: <b>'+n2(D.aiOrthSmh)+'</b> — на каждый 1% полупроводников СВЕРХ рынка ядро отвечает этим процентом книги.'
      :'AI-β орто-SMH скрыта: после ортогонализации знак артефактный — проверь данные (лог на сервере).';
    $('#orthNote').innerHTML='<div class="cs">'+aiNote+'</div>';
    var ciRows=(D.tickers||[]).map(function(t){
      var b=(D.betas||{})[t]||{};
      var ci=b.ci&&b.ci.SMH?(b.ci.SMH[0].toFixed(2)+' … '+b.ci.SMH[1].toFixed(2)):'—';
      var ob=(D.orthBetas||{})[t]||{};
      return '<tr><td class="tk">'+t+'</td><td class="num">'+n2(b.beta?b.beta.SMH:null)+'</td>'
        +'<td class="num">'+(ob.SMH!=null?n2(ob.SMH):'—')+'</td>'
        +'<td class="num">'+ci+'</td>'
        +'<td class="num">'+((D.r2||{})[t]!=null?(D.r2[t]*100).toFixed(0)+'%':'—')+'</td></tr>';
    }).join('');
    var ciTable=$('#ciTable');
    if(ciTable)ciTable.innerHTML='<thead><tr><th>Тикер</th><th class="num">β SMH (сырая)</th><th class="num">β орто-SMH</th><th class="num">95% CI β SMH</th><th class="num">R²</th></tr></thead><tbody>'+ciRows+'</tbody>';
  }

  $('#stressSub').textContent='стресс: SPY-день < −2% ('+D.stress.n+' дн из '+D.stress.rangeDays+') · норма: '+D.normal.n+' дн';
  if(D.stress.dr==null||!D.corrJump.length){
    $('#stressTable').innerHTML='<tbody><tr><td class="cs" style="padding:14px 4px;color:var(--ink3)">'
      +'Стресс-дней меньше 10 даже в расширенном окне до 3 лет ('+D.stress.n+') — условные корреляции не считаем: выборка нерепрезентативна.</td></tr></tbody>';
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
  if(!D.verdicts||!D.verdicts.length){sub.textContent='аномалий нет'+(D.cached?' · кэш':'');$('#detCard').innerHTML=take('все '+D.flagsChecked+' позиций двигаются в пределах, объяснимых их секторами. Ничего не упало «само по себе» — агенту нечего разбирать.');return}
  var damaged=D.verdicts.filter(function(v){return v.verdict==='thesis_damage'}).length;
  var noise=D.verdicts.filter(function(v){return v.verdict==='idiosyncratic_temporary'}).length;
  sub.textContent=D.verdicts.length+' аномалий';
  $('#detCard').innerHTML=take((damaged?'<b>'+damaged+'</b> позиций с признаками повреждения тезиса — смотри их карточки ниже. ':'')+((D.verdicts.length-damaged-noise)>0?'остальные — движение вместе с сектором. ':'')+(noise?'<b>'+noise+'</b> — разовый шум без ущерба бизнесу.':''),damaged>0)
  +D.verdicts.map(function(v){
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
  var OV=D.ov||{};
  function fmtLv(lv){return lv.map(function(v){return v==null?'—':v}).join('/')}
  var trig=items.filter(function(r){return r.status==='triggered'}).length;
  var act=items.filter(function(r){return r.status==='active'}).length;
  $('#falSub').textContent=items.length?act+' активных'+(trig?' · '+trig+' триггеров!':''):'пусто';
  var head=trig
    ?take('<b>'+trig+'</b> тезисов получили триггер — условия смерти сбылись. Закрывай или пересматривай эти позиции.',true)
    :(items.length?take(act+' тезисов под наблюдением, нарушений условий не зафиксировано.'):'');
  var rows=items.map(function(r){
    var last=r.checks&&r.checks.length?r.checks[r.checks.length-1]:null;
    var st=r.status==='triggered'?'<span class="pill r">ТРИГГЕР '+new Date(r.triggeredAt).toLocaleDateString('ru-RU')+'</span>'
      :r.status==='retired'?'<span class="pill d">снят</span>':'<span class="pill g">активна</span>';
    var conds=r.conditions.map(function(c,i){
      var vd=last?(last.verdicts||[]).find(function(x){return x.i===i}):null;
      return '<li>'+esc(c.text)+(vd?' — '+(vd.triggered?'<b class="dn">сработало</b>':esc(vd.evidence)):'')+'</li>';
    }).join('');
    var ovm=OV[r.t];
    var ovl=ovm?'<div class="det-conf mut">агент обновил мета '+new Date(ovm._at).toLocaleDateString('ru-RU')
      +(ovm.lv?': уровни '+fmtLv(ovm.lv):'')
      +(ovm.until?': ждёт «'+esc(ovm.until.event)+'»':'')
      +((ovm._was&&ovm._was.lv)?' (было '+fmtLv(ovm._was.lv)+')':'')
      +' · <button class="lab-btn" data-fal-reset="'+r.t+'">вернуть дефолт</button></div>':'';
    return '<div class="fal-card"><div class="det-h"><b>'+r.t+'</b>'+st
      +(last?'<span class="det-sig mut">чек '+new Date(last.date).toLocaleDateString('ru-RU')+'</span>':'<span class="det-sig mut">ещё не проверялась</span>')
      +'</div><div class="det-reason">тезис: '+esc(r.thesis)+'</div><ol class="fal-conds">'+conds+'</ol>'+ovl
      +'<button class="lab-btn" data-fal-check="'+r.t+'">Проверить</button></div>';
  }).join('');
  $('#falCard').innerHTML=head+(rows||'<div class="cs mut">Реестр пуст. Впиши тикер ниже — например, TSM. Это займёт ~10 секунд, а агент один раз сформулирует, при каких условиях тезис мёртв.</div>')
    +'<div class="fal-new"><input id="falTicker" placeholder="ТИКЕР (напр. TSM)" maxlength="8">'
    +'<button class="lab-btn" id="falGen">Сгенерировать 3 условия</button></div>';
  var genBtn=$('#falGen');
  if(genBtn){
    genBtn.addEventListener('click',function(){
      genBtn.disabled=true;genBtn.textContent='Генерируем…';
      post('/api/lab/falsify',{action:'generate',t:($('#falTicker').value||'').trim().toUpperCase()})
        .then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');genBtn.disabled=false;genBtn.textContent='Сгенерировать 3 условия'});
    });
    lockGuest(genBtn);
  }
  $$('#falCard [data-fal-check]').forEach(function(b){
    b.addEventListener('click',function(){
      b.disabled=true;b.textContent='Проверяем…';
      post('/api/lab/falsify',{action:'check',t:b.dataset.falCheck})
        .then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');b.disabled=false;b.textContent='Проверить'});
    });
    lockGuest(b);
  });
  $$('#falCard [data-fal-reset]').forEach(function(b){
    b.addEventListener('click',function(){
      b.disabled=true;
      post('/api/lab/falsify',{action:'reset',t:b.dataset.falReset})
        .then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');b.disabled=false});
    });
    lockGuest(b);
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
  var wFull=D.weights||{},w=wFull.weights||{},b=D.brier||{},bss=D.bss||{};
  var predsAll=D.predictions||[];
  var waiting=predsAll.filter(function(p){return p.outcome==null}).length;
  var scored=predsAll.filter(function(p){return p.outcome!=null}).length;
  $('#comSub').textContent=predsAll.length?waiting+' ждут исхода · '+scored+' оценено':'';
  var head=scored
    ?take('оценено прогнозов: '+scored+'. Навык меряется Skill Score относительно случайного блуждания (BSS &gt; 0 — агент лучше монетки); вес консенсуса = softmax(BSS)'+(wFull.bucket!=null?', пересчёт раз в 20 исходов':'')+'. Прогнозы с prob ≈ baseline неинформативны и не засчитываются.')
    :take(predsAll.length?('агенты дали '+predsAll.length+' прогнозов. Первый созреет, когда истечёт самый короткий горизонт — тогда появится точность. Пока просто наблюдай.'):'комитет ещё не созывался — нажми «Созвать комитет» или жди еженедельного расписания.');
  var roleRow=D.roles.map(function(r){
    var br=b[r.id],wt=w[r.id],bs=bss[r.id];
    return '<div class="mc-row"><span>'+esc(r.name)+(wt!=null?' · вес '+(wt*100).toFixed(0)+'%':'')+'</span>'
      +'<b>'+(bs&&bs.bss!=null?('BSS '+(bs.bss>=0?'+':'')+bs.bss.toFixed(2)+' (n='+bs.n+')')
        :br==null?'пока без оценки':'Brier '+br.toFixed(3))+'</b></div>';
  }).join('');
  var cal=(D.calibration||[]).filter(function(x){return x.n>0}).map(function(x){
    return '<div class="mc-row"><span>обещали '+(x.claimed*100).toFixed(0)+'%</span><b>сбылось '+(x.hitRate*100).toFixed(0)+'% · n='+x.n+'</b></div>';
  }).join('');
  var preds=predsAll.slice(0,15).map(function(p){
    return '<div class="mc-row"><span>'+esc(ROLENAME[p.role]||p.role)+' · '+esc(evTxt(p.event))+'</span>'
      +'<b>'+(p.prob*100).toFixed(0)+'%'
      +(p.baseline!=null?' <i class="mut" title="вероятность случайного блуждания">база '+(p.baseline*100).toFixed(0)+'%</i>':'')
      +(p.informative===false?' <i class="mut">неинформативен</i>':'')
      +(p.outcome==null?' <i class="mut">ждёт</i>':(p.outcome?' <i class="up">сбылось</i>':' <i class="dn">не сбылось</i>'))+'</b></div>';
  }).join('');
  $('#comCard').innerHTML=head+'<div class="mc-grid"><div><div class="ph">Кто точнее</div>'+roleRow
    +(wFull.basis?'<div class="cs mut">веса: '+esc(wFull.basis)+(wFull.nextRecalcAt!=null?' · пересчёт после '+wFull.nextRecalcAt+' исходов':'')+'</div>':'')
    +'<div class="ph" style="margin-top:12px">Обещанное против сбышегося</div>'+(cal||'<div class="cs mut">пока нет созревших</div>')
    +'<div style="margin-top:14px"><button class="lab-btn" id="comRun">Созвать комитет</button> '
    +'<button class="lab-btn" id="comScore">Оценить созревшие</button></div></div>'
    +'<div><div class="ph">Последние прогнозы</div>'+(preds||'<div class="cs mut">Комитет ещё не созывался.</div>')+'</div></div>';
  var run=$('#comRun');
  if(run){
    run.addEventListener('click',function(){
      run.disabled=true;run.textContent='Комитет думает…';
      post('/api/lab/committee',{action:'run'}).then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');run.disabled=false;run.textContent='Созвать комитет'});
    });
    lockGuest(run);
  }
  var sc=$('#comScore');
  if(sc){
    sc.addEventListener('click',function(){
      sc.disabled=true;sc.textContent='Оцениваем…';
      post('/api/lab/committee',{action:'score'}).then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');sc.disabled=false;sc.textContent='Оценить созревшие'});
    });
    lockGuest(sc);
  }
}

fetch('/api/lab/detector').then(function(r){return r.json()}).then(renderDetector).catch(function(e){$('#detSub').textContent='ошибка: '+e.message});
fetch('/api/lab/falsify').then(function(r){return r.json()}).then(renderFalsify).catch(function(e){$('#falSub').textContent='ошибка: '+e.message});
fetch('/api/lab/committee').then(function(r){return r.json()}).then(renderCommittee).catch(function(e){$('#comSub').textContent='ошибка: '+e.message});

/* ============== журнал: контрфактуалы (#6/#М8) ============== */
function cls2(v){return v==null?'mut':(v>=0?'up':'dn')}
function renderCF(D){
  var items=D.items||[], adv=D.advice, twr=D.twr, levels=D.levels;
  $('#cfSub').textContent=items.length?'решений разобрано: '+items.length:'';
  if(!items.length&&!adv&&!twr){
    $('#cfTable').innerHTML='<tbody><tr><td class="cs" style="padding:12px 4px;color:var(--ink3)">Здесь появится разбор через 30 дней после первого решения: «а что было бы, если просто держать / купить равновесный вотчлист / взять ITOT». Кнопка «Записать решение» — в футере главного терминала; сделки из Tradernet подхватываются сами.</td></tr></tbody>';
    return;
  }
  var edges=[];
  items.forEach(function(x){(x.horizons||[]).forEach(function(h){if(h.edgePct!=null)edges.push(h.edgePct)})});
  var avgEdge=edges.length?edges.reduce(function(s,v){return s+v},0)/edges.length:null;
  var twrLine=twr&&twr.portfolio
    ?'<div class="mc-row"><span>TWR портфеля c '+twr.portfolio.since+'</span><b class="'+cls2(twr.portfolio.value)+'">'+(twr.portfolio.value>=0?'+':'')+(twr.portfolio.value*100).toFixed(1)+'%'
      +(twr.itot&&twr.itot.value!=null?' · ITOT '+(twr.itot.value>=0?'+':'')+(twr.itot.value*100).toFixed(1)+'%':' · ITOT ждёт данных')+'</b></div>'
      +'<div class="cs mut">доходность, взвешенная по времени: тайминг довнесений не искажает сравнение с бенчмарком (записывай довнесения кнопкой «Записать решение»)</div>'
    :'';
  var head=(avgEdge!=null
    ?take(avgEdge>=0
      ?'твой выбор в среднем обгонял альтернативу на <b>+'+n2(avgEdge)+'%</b> по созревшим горизонтам — стокпикинг пока помогает.'
      :'твой выбор в среднем отставал от альтернативы на <b>'+n2(Math.abs(avgEdge))+'</b>% — повод честно пересмотреть подход.',avgEdge<-1)
    :take('решения ещё не созрели для сравнения (нужен месяц).'))+twrLine;
  var rows=items.map(function(x){
    var h30=(x.horizons||[]).find(function(h){return h.h===30});
    var h90=(x.horizons||[]).find(function(h){return h.h===90});
    var h365=(x.horizons||[]).find(function(h){return h.h===365});
    function hcell(h){
      if(!h)return '<td class="num mut">—</td><td class="num mut">—</td>';
      return '<td class="num '+cls2(h.actualPct)+'">'+n2(h.actualPct)+'%</td>'
        +'<td class="num mut">'+n2(h.watchPct!=null?h.watchPct:h.itotPct)+'%'+(h.holdPct!=null?' · держ '+n2(h.holdPct)+'%':'')+'</td>';
    }
    return '<tr><td class="tk">'+x.t+'</td><td>'+(x.type==='buy'?'покупка':x.type==='sell'?'продажа':'пропуск')+'</td>'
      +hcell(h30)+hcell(h90)+hcell(h365)+'</tr>';
  }).join('');
  var advRow=adv&&adv.n
    ?'<tr><td class="tk">Σ</td><td>советы детектора</td><td class="num mut">—</td>'
     +'<td class="num '+cls2(-adv.meanRet)+'">'+(adv.hits+'/'+adv.n)+' сбывалось</td>'
     +'<td class="num mut">—</td><td class="num mut">—</td></tr>'
    :'';
  var lvlRow=levels&&levels.n
    ?'<tr><td class="tk">Σ</td><td>уровни системы</td><td class="num mut">—</td>'
     +'<td class="num '+cls2(levels.meanRet)+'">'+(levels.good+'/'+levels.n)+' выгодно</td>'
     +'<td class="num mut">—</td><td class="num mut">—</td></tr>'
    :'';
  $('#cfTable').innerHTML='<thead><tr><th>Тикер</th><th>Тип</th><th class="num">30д · факт</th><th class="num">30д · альт</th><th class="num">90д · факт</th><th class="num">90д · альт</th><th class="num">365д · факт</th><th class="num">365д · альт</th></tr></thead>'
    +'<tbody><tr><td colspan="8" style="padding:0 0 10px;border:none">'+head+'</td></tr>'+rows+advRow+lvlRow+'</tbody>';
}
fetch('/api/lab/counterfactuals').then(function(r){return r.json()}).then(renderCF).catch(function(e){$('#cfSub').textContent='ошибка: '+e.message});

/* ============== базовые ставки (#7) ============== */
var BR_CLASS={drawdown40:'просадка ≥40% от 52-нед максимума',shock15:'шок-день ≤ −15%'};
function renderBR(D){
  var d=D.data;
  if(!d){$('#brSub').textContent='нет данных — нужен бэкфилл';$('#brCard').innerHTML='<div class="cs mut">Нажми «Бэкфилл вселенной»: загрузит 10 лет истории S&P 500 (~500 тикеров, несколько минут).</div><div style="margin-top:12px"><button class="lab-btn" id="brBackfill">Бэкфилл вселенной</button></div>';hookBR();return}
  $('#brSub').textContent='S&P 500 · '+d.loaded+'/'+d.universe+' тикеров · '+new Date(d.generatedAt).toLocaleDateString('ru-RU');
  var dd=d.agg.drawdown40, sh=d.agg.shock15;
  var head=take('после просадок ≥40% медианный исход через 12 мес — <b>'+(dd&&dd.medianFwd[3]!=null?n2(dd.medianFwd[3])+'%':'—')+'</b>'+((dd&&dd.recoveredShare!=null)?', восстановились к году '+(dd.recoveredShare*100).toFixed(0)+'%':'')+'. Это твой ориентир, когда хочется продать всё на дне.');
  var rows=Object.keys(BR_CLASS).map(function(cls){
    var a=d.agg[cls]; if(!a)return '';
    return '<div class="mc-row"><span>'+BR_CLASS[cls]+' · n='+a.n+'</span>'
      +'<b>через 1м '+n2(a.medianFwd[0])+'% · 3м '+n2(a.medianFwd[1])+'% · 6м '+n2(a.medianFwd[2])+'% · год '+n2(a.medianFwd[3])+'%'
      +(a.recoveredShare!=null?' · восст '+(a.recoveredShare*100).toFixed(0)+'%':'')+'</b></div>';
  }).join('');
  $('#brCard').innerHTML=head+'<div class="lab-warn">Важно: данные по компаниям, которые СЕГОДНЯ в индексе. Обанкротившихся и вылетевших не видно — реальные исходы хуже показанных (survivorship bias).</div>'
    +rows
    +'<div class="ph" style="margin-top:14px">Запрос: что обычно происходит после…</div>'
    +'<div class="fal-new"><input id="brQ" placeholder="напр.: срез гайденса дважды + инсайдеры покупают" style="width:min(340px,100%)">'
    +'<button class="lab-btn" id="brAsk">Спросить</button></div>'
    +'<div id="brAns" style="margin-top:10px"></div>';
  hookBR();
}
function hookBR(){
  var bf=$('#brBackfill');
  if(bf){
    bf.addEventListener('click',function(){
      bf.disabled=true;bf.textContent='Бэкфилл идёт (минуты)…';
      fetch('/api/lab/baserates?backfill=1').then(function(r){return r.json()}).then(function(j){
        if(!j.ok)throw new Error(j.error);
        location.reload();
      }).catch(function(e){basicToast(e.message,'r');bf.disabled=false;bf.textContent='Бэкфилл вселенной'});
    });
    lockGuest(bf);
  }
  var ask=$('#brAsk');
  if(ask){
    ask.addEventListener('click',function(){
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
        }).catch(function(e){basicToast(e.message,'r');ask.disabled=false;ask.textContent='Спросить'});
    });
    lockGuest(ask);
  }
}
fetch('/api/lab/baserates').then(function(r){return r.json()}).then(renderBR).catch(function(e){$('#brSub').textContent='ошибка: '+e.message});

/* ============== капитальный цикл (#8) ============== */
function renderCC(D){
  var d=D.data;
  $('#ccSub').textContent='стадия: '+esc(d.stageLabel)+(D.cached?' · кэш':'');
  var ksOn=d.killSwitch&&d.killSwitch.count>=2;
  var capexUp=d.capex.avgGrowth!=null&&d.capex.avgGrowth>20;
  var head=take(
    'рыночные прокси показывают <b>'+esc(d.stageLabel)+'</b>'
    +(ksOn?' — kill-switch: '+d.killSwitch.count+' из 3 сигналов сжатия ('+esc(d.killSwitch.legs.join(', '))+')':'')
    +'. При этом капекс гиперскейлеров в отчётах '+(d.capex.avgGrowth!=null?(capexUp?'<b>всё ещё растёт</b> (+'+n2(d.capex.avgGrowth)+'% г/г)':'падает'):'недоступен')
    +(ksOn&&capexUp?' — рынок уже не верит в строительство раньше, чем бухгалтерия. Это ранний сигнал стадии цикла.':'.'),
    ksOn);
  var LEGNAME={'^SOX/SPY':'полупроводники vs рынок','URA/SPY':'уран vs рынок','SEMI/SPY':'полуоборудование vs рынок','TLT':'ставки (TLT)'};
  var legs=Object.keys(d.legs).map(function(k){
    var z=d.legs[k];
    return '<div class="mc-row"><span>'+esc(LEGNAME[k]||k)+'</span><b class="'+(z>=0?'up':'dn')+'">'+(z>=0?'выше':'ниже')+' своего среднего (z '+n2(z)+')</b></div>';
  }).join('');
  var capex=d.capex.companies.map(function(c){
    return '<div class="mc-row"><span>'+c.t+'</span><b>'+(c.growth!=null?('капекс за год '+(c.ttm/1e9).toFixed(1)+' млрд $ · '+(c.growth>=0?'+':'')+n2(c.growth)+'% г/г'):('не удалось получить'))+'</b></div>';
  }).join('');
  var ks=ksOn
    ?'<div class="lab-warn">kill-switch: '+d.killSwitch.count+' из 3 рыночных ног в сжатии — исторический порог, за которым AI-цикл обычно сворачивался</div>':'';
  var gpu=d.gpuRent
    ?'<div class="mc-row"><span>аренда GPU (твой ввод)</span><b>$'+n2(d.gpuRent.usdPerGpuHour)+'/GPU·ч от '+new Date(d.gpuRent.date).toLocaleDateString('ru-RU')+'</b></div>'
    :'';
  $('#ccCard').innerHTML=head+'<div class="mc-grid"><div><div class="ph">Рыночные прокси спроса (60 дн)</div>'+legs+ks
    +'<div class="ph" style="margin-top:12px">Капекс гиперскейлеров — факт из их отчётов SEC</div>'+capex
    +(d.capex.avgGrowth!=null?'<div class="mc-row"><span>в среднем по компаниям</span><b>'+(d.capex.avgGrowth>=0?'+':'')+n2(d.capex.avgGrowth)+'% г/г</b></div>':'')
    +'<div class="ph" style="margin-top:12px">Аренда GPU — если есть источник, впиши</div>'+gpu
    +'<div class="fal-new"><input id="gpuIn" type="number" min="0" step="0.01" placeholder="$/GPU·ч, напр. 2.10" style="width:170px"><button class="lab-btn" id="gpuBtn">Записать</button></div>'
    +'</div><div><div class="ph">История стадии по месяцам</div>'
    +d.history.map(function(h){
      return '<div class="mc-row"><span>'+h.month+'</span><b>'+['сжатие','охлаждение','расширение','перегрев'][h.stage]+' (z '+n2(h.composite)+')</b></div>';
    }).join('')
    +'<div class="cs mut" style="margin-top:8px">Прокси — настроение рынка; капекс — что компании реально тратят. Расхождение между ними и есть сигнал стадии.</div>'
    +'</div></div>';
  var g=$('#gpuBtn');
  if(g){
    g.addEventListener('click',function(){
      var v=+($('#gpuIn').value||0); if(!(v>0)){basicToast('введи цену аренды GPU','o');return}
      g.disabled=true;
      fetch('/api/lab/capcycle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'gpu',usd:v})})
        .then(function(r){return r.json()}).then(function(j){ if(!j.ok)throw new Error(j.error); location.reload(); })
        .catch(function(e){basicToast(e.message,'r');g.disabled=false});
    });
    lockGuest(g);
  }
}
fetch('/api/lab/capcycle').then(function(r){return r.json()}).then(renderCC).catch(function(e){$('#ccSub').textContent='ошибка: '+e.message});

/* ============== М1/М3: машина состояний тезисов + очередь пересмотров ============== */
var STATE_META={intact:['цел','g'],watch:['наблюдение','y'],damaged:['повреждён','r'],recovering:['восстановление','b'],dead:['мёртв','r']};
function fmtDate10(iso){return iso?new Date(iso).toLocaleDateString('ru-RU'):''}
function renderTheses(D){
  var items=Object.values(D.items||{});
  var q=D.queue||{};
  var damaged=items.filter(function(r){return r.state==='damaged'}).length;
  var dead=items.filter(function(r){return r.state==='dead'}).length;
  var watchN=items.filter(function(r){return r.state==='watch'}).length;
  $('#thSub').textContent=items.length+' тезисов'+(damaged?' · '+damaged+' повреждено':'')+(dead?' · '+dead+' мертво':'')+(watchN?' · '+watchN+' под наблюдением':'');
  var rows=items.sort(function(a,b){return (STATE_META[a.state]?0:1)-(STATE_META[b.state]?0:1)||a.t.localeCompare(b.t)}).map(function(r){
    var sm=STATE_META[r.state]||['?','d'];
    var lv=r.levels;
    var lvStr=lv?('T1 '+n2(lv.t1)+' · T2 '+n2(lv.t2)+' · T3 '+n2(lv.t3)+(lv.conditional?' <i class="mut">(условные)</i>':'')+(lv.until?' <i class="oc">ждёт: '+esc(lv.until.event)+'</i>':'')):'<span class="mut">аннулированы</span>';
    var exit=r.exit_plan&&r.state==='dead'?'<div class="dn">выход: цель '+(r.exit_plan.target!=null?'$'+n2(r.exit_plan.target):'отскок')+' к '+esc(r.exit_plan.deadline||'—')+'</div>':'';
    var rev=r.review?('к '+r.review.due.slice(8,10)+'.'+r.review.due.slice(5,7)+(r.review.reason?' · '+esc(r.review.reason):'')):'—';
    var revCls=q.queue&&q.queue.some(function(x){return x.t===r.t&&x.priority===0})?' class="dn"':'';
    var last=r.history&&r.history.length?r.history[r.history.length-1]:null;
    var hist=last?fmtDate10(last.date)+': '+(last.from?last.from+' → ':'')+last.to+' ('+esc(last.trigger)+')':'';
    var prop=r.proposed&&r.proposed.state&&r.proposed.state!==r.state?' <i class="mut" title="'+esc(r.proposed.note||'')+'">мнение агента: '+r.proposed.state+'</i>':'';
    return '<tr><td class="tk">'+r.t+'</td>'
      +'<td><span class="pill '+sm[1]+'">'+sm[0]+'</span>'+prop+'</td>'
      +'<td class="nt">'+esc(r.thesis||'—')+(r.damaged_pillars&&r.damaged_pillars.length?'<div class="dn">задето: '+esc(r.damaged_pillars.join(', '))+'</div>':'')+'</td>'
      +'<td class="nt">'+lvStr+exit+'</td>'
      +'<td class="nt"'+revCls+'>'+rev+'</td>'
      +'<td class="nt mut">'+hist+'</td>'
      +'<td class="nt"><button class="lab-btn" data-th-derive="'+r.t+'">Перевывести уровни</button>'
      +'<div class="th-manual"><select data-th-to="'+r.t+'">'
      +Object.keys(STATE_META).map(function(s){return '<option value="'+s+'"'+(s===r.state?' selected':'')+'>'+STATE_META[s][0]+'</option>'}).join('')
      +'</select><button class="lab-btn" data-th-manual="'+r.t+'">Перевести</button></div></td></tr>';
  }).join('');
  $('#thTable').innerHTML='<thead><tr><th>Тикер</th><th>Состояние</th><th>Тезис / опоры</th><th>Уровни</th><th>Пересмотр</th><th>Последний переход</th><th>Действия</th></tr></thead><tbody>'+rows+'</tbody>';
  hookTheses();
  renderQueue(q);
}
function renderQueue(q){
  var parts=[];
  var queue=q.queue||[];
  if(queue.length){
    parts.push('<div class="ph">Пересмотры тезисов</div>'+queue.map(function(x){
      var c=x.priority===0?'r':x.priority===1?'r':x.priority===2?'y':'d';
      return '<div class="mc-row"><span><span class="pill '+c+'">'+(STATE_META[x.state]?STATE_META[x.state][0]:x.state)+'</span> <b>'+x.t+'</b></span><b>'+(x.priority===0?'<span class="dn">'+esc(x.why)+'</span>':esc(x.why))+'</b></div>';
    }).join(''));
  }
  var soon=q.soon||[];
  if(soon.length){
    parts.push('<div class="ph" style="margin-top:12px">Отчёты в ближайшие 7 дней — уровни заморожены</div>'+soon.map(function(s){
      return '<div class="mc-row"><span><b>'+s.t+'</b></span><b>через '+s.days+' дн — полный транш перед отчётом запрещён</b></div>';
    }).join(''));
  }
  var trig=q.falsifyTriggered||[];
  if(trig.length){
    parts.push('<div class="ph" style="margin-top:12px">Сработавшие фальсификации</div>'+trig.map(function(x){
      return '<div class="mc-row"><span><b>'+x.t+'</b></span><b class="dn">'+esc(x.why)+'</b></div>';
    }).join(''));
  }
  var kn=q.known||[];
  if(kn.length){
    parts.push('<div class="ph" style="margin-top:12px">Известные события</div>'+kn.map(function(e){
      return '<div class="mc-row"><span>'+esc(e.label)+'</span><b>через '+e.days+' дн</b></div>';
    }).join(''));
  }
  $('#qSub').textContent=queue.length?(queue.filter(function(x){return x.priority===0}).length+' просрочено · '+(queue.length)+' в очереди'):'пусто';
  $('#qCard').innerHTML=parts.length?parts.join(''):'<div class="cs mut">Очередь пуста: просроченных пересмотров нет, отчётов в ближайшую неделю не видно, фальсификации молчат.</div>';
}
function hookTheses(){
  $$('#thTable [data-th-derive]').forEach(function(b){
    b.addEventListener('click',function(){
      b.disabled=true;b.textContent='Выводим…';
      post('/api/lab/theses',{action:'derive',t:b.dataset.thDerive})
        .then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');b.disabled=false;b.textContent='Перевывести уровни'});
    });
    lockGuest(b);
  });
  $$('#thTable [data-th-manual]').forEach(function(b){
    b.addEventListener('click',function(){
      var t=b.dataset.thManual;
      var sel=document.querySelector('select[data-th-to="'+t+'"]');
      var reason=prompt('Обоснование ручного перехода '+t+' → '+(sel?sel.value:'')+' (пишется в историю):','');
      if(reason==null)return;
      b.disabled=true;
      post('/api/lab/theses',{t:t,to:sel?sel.value:'',reason:reason})
        .then(function(){location.reload()}).catch(function(e){basicToast(e.message,'r');b.disabled=false});
    });
    lockGuest(b);
  });
}
fetch('/api/lab/theses').then(function(r){return r.json()}).then(renderTheses).catch(function(e){$('#thSub').textContent='ошибка: '+e.message});

/* ============== М5: стоит ли покупать ============== */
var DECISION_META={buy_full:['ПОКУПАТЬ ПОЛНЫМ ТРАНШЕМ','g'],buy_half:['ПОЛОВИННЫЙ ТРАНШЕМ','y'],wait:['ЖДАТЬ','y'],no:['НЕТ','r'],no_decision:['НЕТ РЕШЕНИЯ','d']};
function renderBuyCheck(res){
  var ck=res.checklist||{};
  var dm=DECISION_META[res.decision]||['?','d'];
  var rows=[];
  var sm=STATE_META[ck.thesis?ck.thesis.state:'']||null;
  rows.push(['Состояние тезиса',ck.thesis?(STATE_META[ck.thesis.state][0]+(ck.thesis.history&&ck.thesis.history.length?' · переходов: '+ck.thesis.history.length:'')):'нет записи']);
  rows.push(['Отчёт',ck.events&&ck.events.earningsDays!=null?'через '+ck.events.earningsDays+' дн'+(res.binaryRisk?' — БИНАРНЫЙ РИСК':''):'дата неизвестна']);
  rows.push(['Движение',ck.movement?(ck.movement.class==='beta'?'β-движение':ck.movement.class==='noise'?'шум':ck.movement.class==='damage'?'ПОВРЕЖДЕНИЕ':'нет данных')+(ck.movement.reason?' — '+ck.movement.reason:''):'нет данных']);
  rows.push(['Уровни',ck.levels&&ck.levels.active?('T1 '+n2(ck.levels.t1)+' / T2 '+n2(ck.levels.t2)+' / T3 '+n2(ck.levels.t3)+(ck.levels.inZone?' — цена В зоне':'')+(ck.levels.until?' — ждёт: '+esc(ck.levels.until):'')+(ck.levels.frozen?' — ЗАМОРОЖЕНЫ перед отчётом':'')):'не активны']);
  if(ck.constraints){
    rows.push(['Мандат после покупки','имя '+(ck.constraints.namePctAfter*100).toFixed(1)+'% / 8,4%'+(ck.constraints.nameBreached?' — ПРОБИТ':'')
      +' · AI '+(ck.constraints.aiPct*100).toFixed(1)+'%'+(ck.constraints.aiBreached?' — ПРОБИТ':'')
      +' · кэш останется '+(ck.constraints.cashPctAfter*100).toFixed(1)+'%']);
  } else rows.push(['Мандат после покупки','нет данных портфеля']);
  if(ck.baserates)rows.push(['Базовые ставки',ck.baserates.class?''+ck.baserates.class+(ck.baserates.median12m!=null?' · медиана 12м '+n2(ck.baserates.median12m)+'%':''):'класс не определён']);
  var size=res.size||{};
  var sizeStr=(size.shares!=null?('~'+size.shares+' акций по $'+n2(res.px)):'')
    +(size.namePctAfter!=null?' · имя станет '+(size.namePctAfter*100).toFixed(1)+'% книги':'');
  $('#bcAns').innerHTML='<div class="det-card">'
    +'<div class="det-h"><b>'+res.t+' · $'+Math.round(res.usd)+'</b><span class="pill '+dm[1]+'">'+dm[0]+'</span></div>'
    +(res.reason?'<div class="det-reason">'+esc(res.reason)+'</div>':'')
    +(res.wait_what?'<div class="det-pillar">ждать: '+esc(res.wait_what)+'</div>':'')
    +(res.missing&&res.missing.length?'<div class="lab-warn">не хватает: '+res.missing.map(esc).join(' · ')+'</div>':'')
    +'<div style="margin-top:8px">'+rows.map(function(r){return '<div class="mc-row"><span>'+r[0]+'</span><b>'+r[1]+'</b></div>'}).join('')+'</div>'
    +(sizeStr?'<div class="det-conf mut">размер: '+sizeStr+' — посчитано машиной, не агентом</div>':'')
    +'</div>';
}
function hookBuyCheck(){
  var go=$('#bcGo');
  if(!go)return;
  go.addEventListener('click',function(){
    var t=($('#bcTicker').value||'').trim().toUpperCase();
    var usd=+($('#bcUsd').value||0);
    if(!t||!(usd>0)){basicToast('введи тикер и сумму','o');return}
    go.disabled=true;go.textContent='Система думает…';
    post('/api/lab/buycheck',{t:t,usd:usd})
      .then(function(j){renderBuyCheck(j.result);go.disabled=false;go.textContent='Спросить систему'})
      .catch(function(e){basicToast(e.message,'r');go.disabled=false;go.textContent='Спросить систему'});
  });
  lockGuest(go);
}
hookBuyCheck();
