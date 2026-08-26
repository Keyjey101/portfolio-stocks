'use strict';
/* Страница «Анализ акции» (спека 07 §7.1):
   — SSE через fetch + ручной построчный парсинг (Authorization не нужен —
     cookie; но fetch даёт abort и recovery-поллинг /result при обрыве);
   — гибридный прогресс: время × веса шагов + флор реальных шагов;
   — секции результата: вердикт → флаги → скоры → тезис → оценка → бизнес →
     метрики → SEC → сентимент → self-critique → пиры. */

var $=function(s){return document.querySelector(s)};
var TAB='equity';
var abortCtl=null, pollTimer=null, resData=null, curType='equity';

/* ── форматтеры (07 §7.8) ── */
function fmtCur(v){return v==null?'—':'$'+(+v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtNum(v,d){return v==null?'—':(+v).toLocaleString('en-US',{maximumFractionDigits:d==null?2:d})}
function fmtPct(v,d){ if(v==null)return '—'; var s=v>0?'+':''; return s+(+v).toFixed(d==null?1:d)+'%'; }
function fmtRatio(v,d){ return v==null?'—':((+v)*100).toFixed(d==null?1:d)+'%'; }
function fmtSignedRatio(v,d){ if(v==null)return '—'; var s=v>0?'+':''; return s+((+v)*100).toFixed(d==null?1:d)+'%'; }
function fmtLarge(v){
  if(v==null)return '—';
  var a=Math.abs(v);
  if(a>=1e12)return (v/1e12).toFixed(2)+'T';
  if(a>=1e9)return (v/1e9).toFixed(1)+'B';
  if(a>=1e6)return (v/1e6).toFixed(1)+'M';
  if(a>=1e3)return (v/1e3).toFixed(0)+'K';
  return v.toFixed(0);
}
function fmtDate(s){ if(!s)return '—'; var d=new Date(s); return isNaN(d)?String(s):d.toLocaleDateString('ru-RU'); }
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

/* ── словарь RU (enum'ы в JSON английские — перевод только на отображении) ── */
var L={
  verdict:{'Strong Buy':'Сильная покупка','Buy':'Покупка','Hold':'Держать','Avoid':'Избегать','No Decision':'Нет решения',
    'Strong Income Buy':'Сильная дивидендная покупка','Income Buy':'Дивидендная покупка'},
  moat:{switching_cost:'издержки переключения',network_effect:'сетевой эффект',brand:'бренд',cost_advantage:'сниженная себестоимость',
    intangible_assets:'нематериальные активы',efficient_scale:'эффективный масштаб',none:'нет рва',unknown:'не определён'},
  mispricing:{opportunity:'недооценка — возможность',value_trap:'ловушка стоимости',fairly_valued:'справедливо оценена',
    overvalued_justified:'переоценка оправдана',overvalued_bubble:'переоценка-пузырь',unknown:'не определено'},
  tone:{positive:'позитивный',cautiously_optimistic:'осторожно-оптимистичный',neutral:'нейтральный',cautious:'осторожный',negative:'негативный'},
  critique:{proceed:'можно действовать',caution:'осторожно',strong_caution:'серьёзное предупреждение'},
  epsq:{normal:'норма',suspicious_trailing_pe:'подозрительный trailing P/E',likely_one_time_gain:'вероятна разовая прибыль',
    expected_growth:'ожидается рост'},
  cyc:{highly_cyclical:'высокоцикличная',cyclical:'цикличная'},
  insSignal:{heavy_selling:'активные продажи',buying_pressure:'давление покупок',elevated:'повышенная активность',normal:'обычная',none:'нет данных'},
  revType:{recurring:'повторяющаяся выручка',transactional:'транзакционная',project_based:'проектная','project-based':'проектная',
    cyclical:'циклическая',mixed:'смешанная',unknown:'не определена'},
  indTrend:{growing:'растёт',stable:'стабильна',declining:'снижается',disrupted:'разрушается',unknown:'не определена'},
  indCyc:{secular:'секулярный',mild_cyclical:'умеренно цикличный',highly_cyclical:'высокоцикличный',unknown:'не определена'},
  dq:{ok:'в порядке',clamped_vs_price:'клампировано к цене',insufficient_data:'недостаточно данных'},
  scanVerdict:{'STRONGLY UNDERVALUED':'СИЛЬНО НЕДООЦЕНЕНА','MODERATELY UNDERVALUED':'УМЕРЕННО НЕДООЦЕНЕНА',
    'FAIRLY VALUED':'СПРАВЕДЛИВАЯ ЦЕНА','MODERATELY OVERVALUED':'УМЕРЕННО ПЕРЕОЦЕНЕНА','STRONGLY OVERVALUED':'СИЛЬНО ПЕРЕОЦЕНЕНА',
    'AVOID — recent material news':'ИЗБЕГАТЬ — свежие материальные новости'},
  evt:{earnings:'отчётность',guidance:'гайденс',leadership_change:'смена руководства',restatement:'пересмотр отчётности',
    material_agreement:'соглашение',bankruptcy:'банкротство',other:'прочее'},
  horizon:{'6-12 months':'6–12 мес','1-2 years':'1–2 года','3-5 years':'3–5 лет','>5 years':'>5 лет',unknown:'не определён'},
  step:{init:'инициализация',data_fetch:'загрузка данных',sec_filing:'SEC EDGAR',news_radar:'радар новостей',financial:'финансовые метрики',
    business:'бизнес и ров',valuation:'оценка',market_sentiment:'сентимент рынка',risk_analysis:'риск и тезис',decision:'решение',
    cashflow:'денежный поток',quality:'качество дивиденда',portfolio:'роль в портфеле',complete:'готово',result:'готово'},
  newsLvl:{none:'нет',watch:'наблюдение',elevated:'повышенный',severe:'критический',unknown:'нет данных'}
};

/* ── модель прогресса (07 §7.5) ── */
var STEP_W={
  equity:[['init',0,0],['data_fetch',7,4000],['sec_filing',18,7000],['financial',28,2500],['business',46,15000],
          ['valuation',66,15000],['market_sentiment',76,4000],['risk_analysis',92,14000],['decision',100,2500]],
  dividend:[['init',0,0],['data_fetch',7,4000],['financial',17,2500],['cashflow',25,2000],['quality',43,13000],
            ['risk',60,13000],['valuation',77,13000],['portfolio',92,13000],['decision',100,2500]]
};
var progState={startedAt:0,floorW:0,doneW:0,overTimer:null,rafTimer:null};

function progStart(){
  progState.startedAt=Date.now();progState.floorW=0;
  $('#prog').hidden=false;$('#progFill').style.width='0%';
  progPhases();
  if(progState.rafTimer)clearInterval(progState.rafTimer);
  progState.rafTimer=setInterval(progTick,100);
}
/* v4.2: чипы фаз под прогресс-трубой — загораются по реальным шагам SSE */
function progPhases(){
  var el=document.getElementById('progPhases');
  if(!el)return;
  el.innerHTML=STEP_W[curType].map(function(s){
    return '<span class="step" data-p="'+s[0]+'">'+(L.step[s[0]]||s[0])+'</span>';
  }).join('');
}
function progMark(run,done,all){
  var el=document.getElementById('progPhases');
  if(!el)return;
  if(run!=null){
    Array.prototype.forEach.call(el.children,function(c){
      c.classList.toggle('on',c.dataset.p===run);
    });
  }
  if(done!=null){
    var c=el.querySelector('.step[data-p="'+done+'"]');
    if(c)c.classList.add('done');
  }
  if(all)Array.prototype.forEach.call(el.children,function(c){c.classList.remove('on');c.classList.add('done')});
}
function progStop(pct){
  if(progState.rafTimer){clearInterval(progState.rafTimer);progState.rafTimer=null}
  if(pct!=null)$('#progFill').style.width=pct+'%';
  setTimeout(function(){$('#prog').hidden=true},600);
}
function progTick(){
  if(!progState.startedAt)return;
  var table=STEP_W[curType], t=Date.now()-progState.startedAt;
  var totalMs=0, i;
  for(i=0;i<table.length;i++)totalMs+=table[i][2];
  var timeW=0, acc=0;
  for(i=0;i<table.length;i++){
    if(t<=acc+table[i][2]){
      var prevW=i>0?table[i-1][1]:0;
      var frac=table[i][2]>0?(t-acc)/table[i][2]:1;
      timeW=prevW+(table[i][1]-prevW)*frac;
      break;
    }
    acc+=table[i][2];
  }
  if(i>=table.length)timeW=95+4*(1-Math.exp(-(t-totalMs)/30000));
  var pct=Math.min(99,Math.max(timeW,progState.floorW));
  $('#progFill').style.width=pct.toFixed(1)+'%';
  var eta=totalMs-t;
  $('#progEta').textContent=eta>0?('~'+fmtDur(eta)):'вот-вот';
  $('#progStep').textContent=displayStep(table,t)+'…';
}
function displayStep(table,t){
  var acc=0,byTime='init';
  for(var i=0;i<table.length;i++){acc+=table[i][2];if(t<=acc){byTime=table[i][0];break}}
  var adv=[byTime,progState.running,progState.lastDone].filter(Boolean);
  var best='init',bestIdx=-1;
  adv.forEach(function(s){var idx=stepIndex(table,s);if(idx>bestIdx){bestIdx=idx;best=s}});
  return (L.step[best]||best)+'…';
}
function stepIndex(table,name){for(var i=0;i<table.length;i++)if(table[i][0]===name)return i;return -1}
function fmtDur(ms){
  var s=Math.max(0,Math.round(ms/1000));
  var m=Math.floor(s/60);
  return m>0?(m+'м '+(s%60)+'с'):(s+' с');
}
function onFrame(frame){
  if(frame.step&&frame.status==='done'&&frame.step!=='result'&&frame.step!=='complete'){
    var idx=stepIndex(STEP_W[curType],frame.step);
    if(idx>=0)progState.floorW=Math.max(progState.floorW,STEP_W[curType][idx][1]);
    progState.lastDone=frame.step;
    progMark(null,frame.step,false);
  }
  if(frame.step&&frame.status==='running'){progState.running=frame.step;progMark(frame.step,null,false)}
  if(frame.step==='decision'&&frame.status==='done'){
    var d=frame.data||{};
    $('#progStep').textContent='вердикт: '+(L.verdict[d.verdict]||d.verdict||'…');
  }
  if(frame.step==='result')progMark(null,null,true);
}

/* ── SSE-клиент: fetch + построчный парсинг + recovery (07 §7.4) ── */
function urlOf(ticker,type,force){
  var u='/api/equity/analyze/'+encodeURIComponent(ticker)+'/stream?lang=ru';
  if(type==='dividend')u+='&type=dividend';
  if(force)u+='&force=1';
  return u;
}
async function runAnalysis(ticker,type,force){
  if(abortCtl)abortCtl.abort();
  stopPoll();
  curType=type;resData=null;
  $('#err').textContent='';$('#result').hidden=true;$('#result').innerHTML='';
  $('#emptyHint').style.display='none';
  $('#goBtn').disabled=true;$('#goBtn').textContent='Анализируем…';
  $('#resetBtn').hidden=false;$('#copyBtn').hidden=true;
  $('#cacheNote').hidden=true;
  progState.running=null;progState.lastDone=null;
  progStart();
  abortCtl=new AbortController();
  var meta={hit:false};
  try{
    var r=await fetch(urlOf(ticker,type,force),{headers:{Accept:'text/event-stream'},signal:abortCtl.signal});
    if(!r.ok){
      var j=null;try{j=await r.json()}catch(e){}
      throw new Error(j&&j.error?j.error:('HTTP '+r.status));
    }
    var reader=r.body.getReader(),dec=new TextDecoder(),buf='';
    for(;;){
      var chunk=await reader.read();
      if(chunk.done)break;
      buf+=dec.decode(chunk.value,{stream:true});
      var lines=buf.split('\n');buf=lines.pop();
      for(var li=0;li<lines.length;li++){
        var line=lines[li];
        if(line.indexOf('data: ')!==0)continue;
        var frame=null;
        try{frame=JSON.parse(line.slice(6))}catch(e){continue}
        if(frame._cache)meta=frame._cache;
        onFrame(frame);
        if(frame.step==='result'&&frame.status==='done'){resData=frame.data;renderResult(resData,meta);break}
        if(frame.step==='error')throw new Error((frame.data&&frame.data.error)||'анализ не удался');
      }
      if(resData)break;
    }
    if(!resData&&!pollTimer)throw new Error('стрим закрылся без результата');
  }catch(e){
    if(e.name==='AbortError')return;
    // обрыв сети → recovery-поллинг /result (бесплатно; списания не было —
    // у нас нет кредитов, прогон уже идёт и попадёт в кэш)
    startPoll(ticker,type);
    $('#err').textContent='соединение прервано — восстанавливаем результат…';
  }finally{
    $('#goBtn').disabled=false;$('#goBtn').textContent='Анализировать';
    if(resData)progStop(100);
  }
}
function startPoll(ticker,type){
  stopPoll();
  var tries=0;
  pollTimer=setInterval(function(){
    tries++;
    if(tries>210){stopPoll();$('#err').textContent='не дождались результата — попробуй ещё раз';return}
    fetch('/api/equity/analyze/'+encodeURIComponent(ticker)+'/result'+(type==='dividend'?'?type=dividend':''),{cache:'no-store'})
      .then(function(r){
        if(r.status===204)return null;
        if(!r.ok)throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function(j){
        if(!j)return;
        stopPoll();
        resData=j.data;renderResult(resData,{hit:true});
        progStop(100);
        $('#err').textContent='';
      })
      .catch(function(){/* сеть моргнула — попробуем в следующий тик */});
  },3000);
}
function stopPoll(){if(pollTimer){clearInterval(pollTimer);pollTimer=null}}

/* ── рендер ── */
function chip(cls,text,title){return '<span class="pill '+cls+'"'+(title?' title="'+esc(title)+'"':'')+'>'+esc(text)+'</span>'}
function verdictClass(v){
  if(v==='Strong Buy'||v==='Strong Income Buy')return 'g';
  if(v==='Buy'||v==='Income Buy')return 'b';
  if(v==='Hold')return 'y';
  if(v==='Avoid')return 'r';
  return 'd';
}
function scoreCls(v){return v>=75?'g':v>=50?'y':'r'}
function mosCls(v){return v>=15?'g':v<0?'r':'y'}
function valBox(label,val,sub,cls){
  return '<div class="eq-tile '+(cls||'')+'"><div class="ct">'+esc(label)+'</div><div class="cv">'+val+'</div>'
    +(sub?'<div class="cs">'+sub+'</div>':'')+'</div>';
}

function renderResult(R,meta){
  stopPoll();
  $('#result').hidden=false;
  $('#copyBtn').hidden=false;
  $('#cacheNote').hidden=false;
  var expires=meta&&meta.expires_at?new Date(meta.expires_at*1000):null;
  $('#cacheNote').innerHTML=(meta&&meta.hit
    ?'результат из кэша, истекает '+fmtHHMM(expires)
    :'свежий результат, кэш до '+fmtHHMM(expires))
    +' · <button class="eq-linkbtn" id="forceBtn">пересчитать</button>';
  var fb=document.getElementById('forceBtn');
  if(fb)fb.onclick=function(){runAnalysis(R.ticker,curType,true)};

  $('#result').innerHTML = curType==='equity'?renderEquity(R):renderDividend(R);
  FX.stagger($('#result'));
  FX.drawIn($('#result'));
  document.title=(R.ticker||'тикер')+' — анализ';
}
function fmtHHMM(d){return d&&!isNaN(d)?d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—'}

function renderEquity(R){
  var v=R.valuation||{},d=R.decision||{},b=R.business_analysis||{},rt=R.risk_thesis||{},ef=R.event_flags||{},
      fm=R.financial_metrics||{},sec=R.sec_filing_data||{},ms=R.market_sentiment||{},H=[];
  var vLabel=L.verdict[d.verdict]||d.verdict||'—';
  var vCls=verdictClass(d.verdict);
  var noEst=v.no_estimate||d.verdict==='No Decision';

  /* 1. вердикт-баннер */
  H.push('<section class="bez spot eq-vb vc-'+vCls+'"><div class="core">');
  H.push('<div class="eq-vb-row"><div class="eq-vb-main">');
  H.push('<div class="eyebrow"><i class="led" style="--cc:var(--'+(vCls==='g'?'g':vCls==='b'?'mc':vCls==='y'?'y':vCls==='r'?'r':'d')+')"></i> вердикт системы</div>');
  H.push('<div class="eq-vb-name">'+esc(R.name||R.ticker)+' <span class="mut">('+esc(R.ticker)+')</span>'
    +(fm.cyclicality_tag?' '+chip('d',L.cyc[fm.cyclicality_tag]):'')+'</div>');
  H.push('<div class="eq-vb-verdict">'+esc(vLabel)+'</div>');
  H.push('<div class="eq-vb-chips">'
    +chip(vCls,'скор '+fmtNum(d.total_score,1)+'/100')
    +chip('d','уверенность '+(d.confidence_pct!=null?d.confidence_pct:'—')+'%')
    +(d.time_horizon?chip('d','горизонт: '+(L.horizon[d.time_horizon]||d.time_horizon)):'')
    +(rt.mispricing_type?chip(rt.mispricing_type==='opportunity'?'g':rt.mispricing_type==='value_trap'?'r':'y',L.mispricing[rt.mispricing_type]||rt.mispricing_type):'')
    +'</div>');
  H.push('</div><div class="eq-vb-side">');
  H.push('<div class="eq-vb-price">'+fmtCur(R.current_price)+'</div>');
  if(noEst){
    H.push('<div class="cs">точечной оценки нет — диапазон</div><div class="eq-vb-range">'+fmtCur(v.range_low)+' … '+fmtCur(v.range_high)+'</div>');
  }else{
    H.push('<div class="cs">справедливая (base)</div><div class="eq-vb-range">'+fmtCur(v.dcf_base)+'</div>');
    H.push('<div class="cs">MoS <b class="'+mosCls(v.margin_of_safety_pct)+'">'+fmtPct(v.margin_of_safety_pct)+'</b></div>');
  }
  H.push('</div></div></div></section>');

  /* 2. деградация */
  if(R.agents_failed>0){
    H.push('<div class="eq-warn">Упало агентов: '+R.agents_failed+' — выводы опираются на фоллбеки, уверенность занижена.</div>');
  }
  /* 3. event-флаги */
  var flags=[];
  if(ef.stale_filing)flags.push(chip('r','D1 · материальное событие не отражено в отчётности'));
  if(ef.active_ma_offer)flags.push(chip('b','D3 · активное M&A-предложение — вердикт приостановлен'));
  if(ef.unexplained_move)flags.push(chip('d','D4 · движение '+fmtPct((ef.return_90d||0)*100)+' за 90 дней без материальных новостей'
    +(ef.unexplained_move_severe?' (сильное — No Decision)':'')));
  if(flags.length)H.push('<div class="eq-flags">'+flags.join(' ')+'</div>');
  /* 4. дисклеймер */
  H.push('<div class="eq-disc">Не является индивидуальной инвестиционной рекомендацией. Оценка модельная и может ошибаться.</div>');

  /* 5. пять карточек скора */
  var cs=d.component_scores||{};
  var cardDefs=[
    ['Качество бизнеса',cs.business_quality,esc(b.moat_type?L.moat[b.moat_type]:'—')+' · ров '+fmtNum(b.moat_score,0)+'/10'],
    ['Финансовая сила',cs.financial_strength,'ROIC '+fmtRatio(fm.avg_roic)+' · FCF-лет '+fm.fcf_positive_years+'/'+fm.fcf_available_years],
    ['Рост',cs.growth,'выручка CAGR3 '+fmtRatio(fm.revenue_cagr_3y)+' · '+(fm.revenue_trend==='improving'?'улучшается':fm.revenue_trend==='declining'?'снижается':'стабильно')],
    ['Оценка',cs.valuation,'MoS '+fmtPct(v.margin_of_safety_pct)+' · скор '+fmtNum(v.valuation_score,0)+'/10'],
    ['Риск',cs.risk,L.mispricing[rt.mispricing_type]||'—'+(rt.time_horizon?' · '+(L.horizon[rt.time_horizon]||rt.time_horizon):'')]
  ];
  H.push('<section class="grp"><div class="gh"><h3>Компоненты решения</h3><span class="pct">веса: '+weightStr(d.sector_weights)+'</span></div>');
  H.push('<div class="eq-cards">'+cardDefs.map(function(c){
    return '<div class="eq-scorecard"><div class="ct">'+esc(c[0])+'</div>'
      +'<div class="cv '+(c[1]!=null?scoreCls(c[1]):'')+'">'+(c[1]!=null?fmtNum(c[1],0):'—')+'<small>/100</small></div>'
      +'<div class="vbar"><i style="width:'+(c[1]!=null?Math.max(2,c[1]):2)+'%"></i></div>'
      +'<div class="cs">'+(c[2]||'')+'</div></div>';
  }).join('')+'</div></section>');

  /* 6. тезис */
  H.push('<section class="grp"><div class="gh"><h3>Инвестиционный тезис</h3><span class="pct">риск '+fmtNum(rt.risk_score,0)+'/10</span></div>');
  H.push('<div class="bez spot"><div class="core eq-prose">');
  if(rt.why_cheap_or_expensive)H.push('<p><b>Почему дёшево/дорого:</b> '+esc(rt.why_cheap_or_expensive)+'</p>');
  if(rt.what_market_misses)H.push('<p><b>Что упускает рынок:</b> '+esc(rt.what_market_misses)+'</p>');
  if(rt.thesis_summary)H.push('<p class="eq-thesis">'+esc(rt.thesis_summary)+'</p>');
  if(rt.catalysts&&rt.catalysts.length)H.push('<p><b>Катализаторы:</b></p><ul>'+rt.catalysts.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>');
  if(rt.key_risks&&rt.key_risks.length)H.push('<p><b>Ключевые риски:</b></p><ul>'+rt.key_risks.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>');
  H.push('</div></div></section>');

  /* 7. оценка */
  H.push('<section class="grp"><div class="gh"><h3>Справедливая стоимость</h3><span class="pct">'+esc(v.assumptions||'')+'</span></div>');
  H.push('<div class="bez spot"><div class="core">');
  if(noEst){
    H.push('<div class="eq-noest">Нет надёжной точечной оценки'+(v.valuation_flags&&v.valuation_flags.indexOf('cyclical_range_only')>=0?' (высокоцикличная компания — работает только диапазон)':'')+'. Диапазон: <b>'+fmtCur(v.range_low)+' — '+fmtCur(v.range_high)+'</b>.</div>');
  }else{
    H.push('<div class="eq-sc3">'
      +valBox('медведь · 25%',fmtCur(v.dcf_bear),'','r')
      +valBox('база · 50%',fmtCur(v.dcf_base),'','y')
      +valBox('бык · 25%',fmtCur(v.dcf_bull),'','g')+'</div>');
    H.push('<div class="eq-evbar"><div class="eq-ev-scale"><i style="left:'+(v.range_low?(100*Math.min(95,Math.max(5,R.current_price/v.dcf_bull*100))):50)+'%"></i></div></div>');
  }
  if(v.framing)H.push('<p class="eq-framing">'+esc(v.framing)+'</p>');
  H.push('<div class="eq-evrow"><span>ожидаемая стоимость (25/50/25): <b>'+fmtCur(v.expected_value)+'</b></span>'
    +'<span>MoS: <b class="'+mosCls(v.margin_of_safety_pct)+'">'+fmtPct(v.margin_of_safety_pct)+'</b></span></div>');
  if(v.methods&&v.methods.length){
    H.push('<div class="eq-methods">'+v.methods.map(function(m){
      return '<span class="eq-mchip" title="вес '+(m.weight*100).toFixed(0)+'%">'+m.name+' · '+fmtCur(m.value)+' · '+(m.weight*100).toFixed(0)+'%</span>';
    }).join('')+'</div>');
  }
  var det=[];
  det.push(['EPV (без роста)',fmtCur(v.earnings_power_value)]);
  det.push(['Цель аналитиков (PV)',fmtCur(v.analyst_target)+' ('+fmtCur(v.analyst_target_pv)+')']);
  det.push(['WACC / ke',fmtRatio(v.wacc)+' / '+fmtRatio(v.cost_of_equity)]);
  det.push(['Рост g / терминальный',fmtRatio(v.growth_used)+' / '+(v.terminal_growth!=null?fmtRatio(v.terminal_growth):'—')]);
  if(v.dcf_assumptions)det.push(['Допущения DCF',esc(v.dcf_assumptions)]);
  if(v.relative_assessment)det.push(['Относительно истории',esc(v.relative_assessment)]);
  if(v.is_cyclically_adjusted)det.push(['Нормализация','прибыль циклически нормализована']);
  if(v.data_quality&&v.data_quality!=='ok')det.push(['Качество данных',chip('y',L.dq[v.data_quality]||v.data_quality)]);
  H.push('<table class="eq-det">'+det.map(function(r2){return '<tr><td>'+r2[0]+'</td><td class="num">'+r2[1]+'</td></tr>'}).join('')+'</table>');
  if(v.valuation_narrative)H.push('<div class="eq-narr">'+esc(v.valuation_narrative)+'</div>');
  H.push('</div></div></section>');

  /* 8. бизнес */
  H.push('<section class="grp"><div class="gh"><h3>Бизнес и ров</h3><span class="pct">score '+fmtNum(b.business_score,0)+'/10</span></div>');
  H.push('<div class="bez spot"><div class="core eq-prose">');
  H.push('<div class="eq-moatrow">'+chip('b',L.moat[b.moat_type]||b.moat_type||'—')+' '+chip('d',L.revType[b.revenue_type]||b.revenue_type||'—')
    +' '+chip(b.industry_trend==='growing'?'g':b.industry_trend==='declining'?'r':'d','отрасль: '+(L.indTrend[b.industry_trend]||'—'))
    +' '+chip('d',L.indCyc[b.industry_cyclicality]||'—')+'</div>');
  if(b.business_model)H.push('<p>'+esc(b.business_model)+'</p>');
  if(b.moat_description)H.push('<p><b>Ров:</b> '+esc(b.moat_description)+'</p>');
  if(b.key_insights&&b.key_insights.length)H.push('<ul>'+b.key_insights.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>');
  if(b.concerns&&b.concerns.length)H.push('<p class="mut"><b>Опасения:</b> '+b.concerns.map(esc).join(' · ')+'</p>');
  H.push('</div></div></section>');

  /* 9. сетка метрик */
  var mu=R.multiples||{};
  var tiles=[
    ['Выручка CAGR3',fmtRatio(fm.revenue_cagr_3y),fm.revenue_trend],
    ['ROIC ср.',fmtRatio(fm.avg_roic),fm.margin_trend],
    ['Опер. маржа ср.',fmtRatio(fm.avg_operating_margin),fm.margin_trend],
    ['FCF-лет +',fm.fcf_positive_years+'/'+fm.fcf_available_years,null],
    ['Долг/EBITDA ср.',fm.avg_debt_ebitda!=null?fmtNum(fm.avg_debt_ebitda,1):'—',fm.debt_stress_flag?'стресс':null],
    ['Piotroski',fm.piotroski_f+'/7',null],
    ['P/E trail',fmtNum(mu.pe_trailing,1),null],
    ['P/E fwd',fmtNum(mu.pe_forward,1),L.epsq[fm.eps_quality_flag]||fm.eps_quality_flag],
    ['EPS trail/fwd',fmtNum(fm.trailing_eps,2)+' / '+fmtNum(fm.forward_eps,2),null],
    ['EV/EBITDA',fmtNum(mu.ev_ebitda,1),null],
    ['FCF yield',fmtRatio(mu.fcf_yield),null],
    ['Капитализация','$'+fmtLarge(R.market_cap),null],
    ['β',fmtNum(R.beta,2),null],
    ['Цель аналитиков',fmtCur(R.analyst&&R.analyst.target_mean),(R.analyst&&R.analyst.recommendation)||null],
    ['Дивид. yield',fmtRatio(R.dividend_data&&R.dividend_data.yield),null]
  ];
  H.push('<section class="grp"><div class="gh"><h3>Финансовые метрики</h3></div><div class="eq-mgrid">'
    +tiles.map(function(t){return '<div class="eq-mtile"><div class="ct">'+esc(t[0])+'</div><div class="mv">'+t[1]+'</div>'
      +(t[2]?'<div class="cs">'+esc(t[2])+'</div>':'')+'</div>'}).join('')+'</div></section>');

  /* 10. SEC */
  if(sec&&sec.data_available){
    H.push('<section class="grp"><div class="gh"><h3>SEC-отчётность</h3><span class="pct">'
      +chip('d','10-K '+fmtDate(sec.last_10k_date))+' '+chip('d','10-Q '+fmtDate(sec.last_10q_date))
      +' '+(sec.filing_tone?chip(sec.filing_tone==='positive'?'g':(sec.filing_tone==='cautious'||sec.filing_tone==='negative')?'y':'d','тон: '+(L.tone[sec.filing_tone]||sec.filing_tone)):'')
      +'</span></div>');
    H.push('<div class="bez spot"><div class="core">');
    if(sec.filing_staleness_warning)H.push('<div class="eq-warn">'+esc(sec.filing_staleness_warning)+'</div>');
    var sTiles=[
      ['Выручка YoY',fmtPct(sec.revenue_change_pct)],
      ['Чистая прибыль YoY',fmtPct(sec.net_income_change_pct)],
      ['EPS YoY',fmtPct(sec.eps_change_pct)],
      ['D/(D+E)',sec.debt_to_equity!=null?fmtRatio(sec.debt_to_equity):'—'],
      ['Долг YoY',fmtPct(sec.debt_change_pct)],
      ['Опер. маржа',sec.operating_margin!=null?fmtNum(sec.operating_margin,1)+'%':'—'],
      ['FCF YoY',fmtPct(sec.fcf_change_pct)],
      ['Инсайдеры',L.insSignal[(sec.recent_form4||{}).activity_signal]||'нет данных']
    ];
    H.push('<div class="eq-mgrid">'+sTiles.map(function(t){return '<div class="eq-mtile"><div class="ct">'+esc(t[0])+'</div><div class="mv">'+t[1]+'</div></div>'}).join('')+'</div>');
    var f4=sec.recent_form4||{};
    H.push('<div class="eq-insrow">покупки инсайдеров: <b class="up">$'+fmtLarge(f4.total_buy_value_usd)+'</b> ('+(f4.buy_count||0)+')'
      +' · продажи: <b class="dn">$'+fmtLarge(f4.total_sell_value_usd)+'</b> ('+(f4.sell_count||0)+')</div>');
    if(sec.quarterly_series&&sec.quarterly_series.Revenues&&sec.quarterly_series.Revenues.length>1){
      H.push('<div class="eq-spark">'+sparkSvg(sec.quarterly_series.Revenues.map(function(q){return q.val}))+'<span class="cs">выручка по кварталам (XBRL)</span></div>');
    }
    if(sec.recent_8k_events&&sec.recent_8k_events.length){
      H.push('<div class="eq-8klist">'+sec.recent_8k_events.map(function(e){
        return '<div class="eq-8k"><span class="mut">'+fmtDate(e.date)+'</span> '+chip(e.event_type==='restatement'?'r':e.event_type==='earnings'?'b':'d',L.evt[e.event_type]||e.event_type)+' <span>'+esc(e.description||'')+'</span></div>';
      }).join('')+'</div>');
    }
    if(sec.mda_summary)H.push('<div class="eq-prose" style="margin-top:10px"><b>MD&A 10-K:</b> '+esc(sec.mda_summary)+'</div>');
    if(sec.top_risks&&sec.top_risks.length)H.push('<div class="eq-prose"><b>Главные риски из 10-K:</b> '+sec.top_risks.slice(0,3).map(esc).join(' · ')+'</div>');
    if(rt.sec_filing_assessment)H.push('<div class="eq-prose mut">'+esc(rt.sec_filing_assessment)+'</div>');
    H.push('</div></div></section>');
  }

  /* 11. сентимент */
  H.push('<section class="grp"><div class="gh"><h3>Рыночный сентимент</h3></div>');
  var si=ms.short_interest,os=ms.options_sentiment,ed=ms.earnings_data||{};
  if(!si&&!os&&(ed.days_until_earnings==null)){
    H.push('<div class="bez"><div class="core cs mut">данные сентимента недоступны</div></div></section>');
  }else{
    H.push('<div class="bez spot"><div class="core"><div class="eq-mgrid">');
    if(si)H.push(mTile('Short % float',fmtNum(si.short_pct_of_float,1)+'%','сигнал: '+(si.signal==='short_squeeze_potential'?'потенциал сквиза':si.signal==='high_short_interest'?'высокий':si.signal==='moderate_short_interest'?'умеренный':'низкий')));
    if(si&&si.short_ratio!=null)H.push(mTile('Short ratio',fmtNum(si.short_ratio,2)));
    if(os)H.push(mTile('Put/Call (объём / OI)',fmtNum(os.put_call_ratio,2)+' / '+fmtNum(os.put_call_ratio_oi,2),'сигнал: '+(os.signal==='bearish'?'медвежий':os.signal==='bullish'?'бычий':'нейтральный')));
    if(os&&os.implied_volatility!=null)H.push(mTile('IV (медиана call)',fmtNum(os.implied_volatility,1)+'%',os.nearest_expiry?'экспири '+os.nearest_expiry:null));
    if(ed.days_until_earnings!=null)H.push(mTile('До отчёта',ed.days_until_earnings+' дн',fmtDate(ed.next_earnings_date)));
    if(ed.avg_eps_surprise_pct!=null)H.push(mTile('Сюрприз EPS ср.',fmtPct(ed.avg_eps_surprise_pct)));
    H.push('</div>');
    if(ms.sentiment_interpretation)H.push('<div class="cs" style="margin-top:8px">'+esc(ms.sentiment_interpretation)+'</div>');
    H.push('</div></div></section>');
  }

  /* 12. self-critique */
  var sc=d.self_critique;
  if(sc&&sc.bear_case){
    H.push('<section class="grp"><div class="gh"><h3>Self-critique</h3>'+chip(sc.final_assessment==='proceed'?'g':sc.final_assessment==='caution'?'y':'r',L.critique[sc.final_assessment]||sc.final_assessment)+'</div>');
    H.push('<div class="bez spot"><div class="core eq-prose"><p>'+esc(sc.bear_case)+'</p>'
      +(sc.missed_risks&&sc.missed_risks.length?'<p class="mut">Упущено моделью: '+sc.missed_risks.map(esc).join(' · ')+'</p>':'')
      +'</div></div></section>');
  }

  /* 13. пиры */
  if(R.peers_comparison&&R.peers_comparison.length){
    var me={pe_trailing:mu.pe_trailing,pe_forward:mu.pe_forward,ev_ebitda:mu.ev_ebitda,roe:fm.avg_roe,revenue_growth:R.analyst&&R.analyst.revenue_growth};
    H.push('<section class="grp"><div class="gh"><h3>Сравнение с пирами</h3></div><div class="tw bez spot"><div class="core"><table>');
    H.push('<thead><tr><th>Тикер</th><th class="num">Цена</th><th class="num">Cap</th><th class="num">P/E trail</th><th class="num">P/E fwd</th><th class="num">EV/EBITDA</th><th class="num">Рост выр.</th><th class="num">ROE</th></tr></thead><tbody>');
    H.push(peerRow(R.ticker+' (сам)',R.current_price,R.market_cap,me,true));
    R.peers_comparison.forEach(function(p){H.push(peerRow(p.ticker,p.current_price,p.market_cap,p,false))});
    H.push('</tbody></table></div></div></section>');
  }
  return H.join('');
}
function peerRow(name,price,cap,m,isMe){
  var tri=function(mine,theirs,invert){
    if(mine==null||theirs==null)return '';
    var better=invert?theirs<mine:theirs>mine;
    var eq=Math.abs(mine-theirs)/(Math.abs(theirs)||1)<0.05;
    if(eq)return '<span class="mut">≈</span>';
    return better?'<span class="up">▲</span>':'<span class="dn">▼</span>';
  };
  var cell=function(v,cmpV,invert,fmt){
    return '<td class="num">'+(v!=null?fmt(v):'—')+' '+tri(v,cmpV,invert)+'</td>';
  };
  return '<tr'+(isMe?' style="background:rgba(217,166,63,.08)"':'')+'><td class="tk">'+esc(name)+'</td>'
    +'<td class="num">'+fmtCur(price)+'</td><td class="num">$'+fmtLarge(cap)+'</td>'
    +'<td class="num">'+fmtNum(m.pe_trailing,1)+'</td><td class="num">'+fmtNum(m.pe_forward,1)+'</td>'
    +'<td class="num">'+fmtNum(m.ev_ebitda,1)+'</td><td class="num">'+fmtRatio(m.revenue_growth)+'</td><td class="num">'+fmtRatio(m.roe)+'</td></tr>';
}
function mTile(label,val,sub){
  return '<div class="eq-mtile"><div class="ct">'+esc(label)+'</div><div class="mv">'+val+'</div>'+(sub?'<div class="cs">'+esc(sub)+'</div>':'')+'</div>';
}
function sparkSvg(vals){
  var W=160,Hh=28,pad=2;
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);
  if(mx<=mn)mx=mn+1;
  var pts=vals.map(function(v,i){
    return [+(pad+(W-2*pad)*i/(vals.length-1)).toFixed(1),+(Hh-pad-(Hh-2*pad)*(v-mn)/(mx-mn)).toFixed(1)];
  });
  var upTrend=vals[vals.length-1]>=vals[0];
  return '<svg viewBox="0 0 '+W+' '+Hh+'" width="'+W+'" height="'+Hh+'" aria-hidden="true"><path class="spk-line" d="'+FX.smoothPath(pts)+'" fill="none" stroke="'+(upTrend?'#0e8a5f':'#c43d33')+'" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function weightStr(w){
  if(!w)return '';
  return 'бизнес '+Math.round(w.business*100)+' · финансы '+Math.round(w.financial*100)+' · рост '+Math.round(w.growth*100)+' · оценка '+Math.round(w.valuation*100)+' · риск '+Math.round(w.risk*100);
}

/* див. ветка (04 §4.9) */
function renderDividend(R){
  var d=R.decision||{},q=R.dividend_quality||{},r=R.dividend_risk||{},vv=R.dividend_valuation||{},
      pg=R.portfolio_guidance||{},cf=R.cashflow_analysis||{},H=[];
  var vLabel=L.verdict[d.verdict]||d.verdict||'—';
  var vCls=verdictClass(d.verdict);
  H.push('<section class="bez spot eq-vb vc-'+vCls+'"><div class="core"><div class="eq-vb-row"><div class="eq-vb-main">');
  H.push('<div class="eyebrow"><i class="led" style="--cc:var(--'+(vCls==='g'?'g':vCls==='b'?'mc':vCls==='y'?'y':vCls==='r'?'r':'d')+')"></i> дивидендный вердикт</div>');
  H.push('<div class="eq-vb-name">'+esc(R.name||R.ticker)+' <span class="mut">('+esc(R.ticker)+')</span></div>');
  H.push('<div class="eq-vb-verdict">'+esc(vLabel)+'</div>');
  H.push('<div class="eq-vb-chips">'+chip(vCls,'скор '+fmtNum(d.total_score,0)+'/100')
    +chip('d','уверенность '+(d.confidence_pct!=null?d.confidence_pct:'—')+'%')
    +chip(q.yield_trap_flag?'r':'g',q.yield_trap_flag?'флаг yield-ловушки':'без флагов ловушки')+'</div>');
  H.push('</div><div class="eq-vb-side"><div class="eq-vb-price">'+fmtCur(R.current_price)+'</div>');
  var dd=R.dividend_data||{};
  H.push('<div class="cs">yield '+fmtRatio(dd.yield)+'</div><div class="cs">YoC 3г '+fmtRatio(d.forward_yield_3y)+'</div>');
  H.push('<div class="cs">E[total return] <b>'+fmtSignedRatio(d.expected_total_return)+'</b></div>');
  H.push('</div></div></div></section>');
  if(R.agents_failed>0)H.push('<div class="eq-warn">Упало агентов: '+R.agents_failed+' — часть выводов на фоллбеках.</div>');
  var cs=d.component_scores||{};
  var cards=[['Качество дивиденда',cs.dividend_quality,q.notes],['Устойчивость payout',cs.payout_safety,'FCF-покрытие '+fmtNum(cf.avg_fcf_coverage,1)+'×'],
    ['Против среза',cs.cut_risk,'риск среза '+r.cut_risk_pct+'%'],['Доходный апсайд',cs.income_upside,'рост DPS '+fmtSignedRatio(vv.expected_dps_growth_rate)]];
  H.push('<section class="grp"><div class="gh"><h3>Компоненты</h3></div><div class="eq-cards">'
    +cards.map(function(c){return '<div class="eq-scorecard"><div class="ct">'+esc(c[0])+'</div><div class="cv '+(c[1]!=null?scoreCls(c[1]):'')+'">'+(c[1]!=null?fmtNum(c[1],0):'—')+'<small>/100</small></div><div class="vbar"><i style="width:'+(c[1]!=null?Math.max(2,c[1]):2)+'%"></i></div><div class="cs">'+esc(c[2]||'')+'</div></div>'}).join('')+'</div></section>');
  var cutCls=r.cut_risk_pct<=15?'g':r.cut_risk_pct<=40?'y':'r';
  H.push('<section class="grp"><div class="gh"><h3>Дивидендный разбор</h3></div><div class="bez spot"><div class="core eq-prose">');
  H.push('<p><b>Тип:</b> '+esc(q.dividend_type)+' · payout '+fmtRatio(q.payout_ratio)+' · безопасность '+fmtNum(q.dividend_safety,0)+'/10 · устойчивость роста '+fmtNum(q.growth_sustainability,0)+'/10</p>');
  H.push('<p><b>Риск среза:</b> '+chip(cutCls,r.cut_risk_pct+'%')+' '+esc(r.primary_risk_type||'')+' — '+esc(r.rationale||'')+'</p>');
  H.push('<p><b>Оценка:</b> YoC 3г/5г '+fmtRatio(vv.yield_on_cost_3y)+' / '+fmtRatio(vv.yield_on_cost_5y)+'; ожидаемый total return '+fmtSignedRatio(vv.total_return_estimate)+'.</p>');
  H.push('<p><b>Роль в портфеле:</b> '+esc(pg.portfolio_role)+(pg.suggested_allocation_pct?' · рекомендация ≤'+pg.suggested_allocation_pct+'%':'')+' — '+esc(pg.allocation_rationale||'')+'</p>');
  H.push('<p class="mut">FCF: '+cf.fcf_positive_years+'/'+cf.fcf_available_years+' лет положительный, тренд '+esc(cf.fcf_trend)+'.</p>');
  H.push('</div></div></section>');
  return H.join('');
}

/* ── копия результата в буфер (TSV, зеркалит секции) ── */
function copyResult(){
  if(!resData){return}
  var R=resData,lines=[];
  function row(){lines.push(Array.prototype.slice.call(arguments).join('\t'))}
  row('АНАЛИЗ',R.ticker,R.name,new Date().toISOString());
  row('Цена',R.current_price,'Cap',R.market_cap);
  if(curType==='equity'){
    var d=R.decision||{};
    row('Вердикт',d.verdict,'Скор',d.total_score,'Уверенность',d.confidence_pct);
    row('MoS%',(R.valuation||{}).margin_of_safety_pct,'Base',(R.valuation||{}).dcf_base,'Bear',(R.valuation||{}).dcf_bear,'Bull',(R.valuation||{}).dcf_bull);
    var cs=d.component_scores||{};
    row('Компоненты','бизнес '+cs.business_quality,'финансы '+cs.financial_strength,'рост '+cs.growth,'оценка '+cs.valuation,'риск '+cs.risk);
    if(R.risk_thesis)row('Тезис',R.risk_thesis.thesis_summary||'');
    (R.valuation&&R.valuation.methods||[]).forEach(function(m){row('Метод',m.name,m.value,(m.weight*100).toFixed(0)+'%')});
  }else{
    var dd=R.decision||{};
    row('Вердикт',dd.verdict,'Скор',dd.total_score,'Уверенность',dd.confidence_pct);
    row('YoC3',(dd.forward_yield_3y),'TotalReturn',(dd.expected_total_return));
  }
  var txt=lines.join('\n');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){basicToast('Результат скопирован (TSV)')},function(){fallbackCopy(txt)});
  }else fallbackCopy(txt);
}
function fallbackCopy(txt){
  var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');basicToast('Результат скопирован (TSV)')}catch(e){basicToast('не удалось скопировать','r')}
  ta.remove();
}

/* ── UI-обвязка ── */
function setTab(t){
  TAB=t;curType=t;
  $('#tabEquity').classList.toggle('on',t==='equity');
  $('#tabDividend').classList.toggle('on',t==='dividend');
}
$('#tabEquity').addEventListener('click',function(){setTab('equity')});
$('#tabDividend').addEventListener('click',function(){setTab('dividend')});
$('#goBtn').addEventListener('click',function(){
  var t=($('#tkr').value||'').toUpperCase().trim();
  if(!t){$('#err').textContent='впиши тикер';return}
  if(!/^[A-Z0-9.\-]+$/.test(t)){$('#err').textContent='тикер выглядит странно';return}
  runAnalysis(t,TAB,false);
});
$('#tkr').addEventListener('keydown',function(e){if(e.key==='Enter')$('#goBtn').click()});
$('#resetBtn').addEventListener('click',function(){
  if(abortCtl)abortCtl.abort();
  stopPoll();resData=null;progStop();progState.startedAt=0;
  $('#result').hidden=true;$('#result').innerHTML='';$('#err').textContent='';
  $('#resetBtn').hidden=true;$('#copyBtn').hidden=true;$('#cacheNote').hidden=true;
  $('#emptyHint').style.display='';$('#goBtn').disabled=false;$('#goBtn').textContent='Анализировать';
  document.title='Анализ акции';
});
$('#copyBtn').addEventListener('click',copyResult);

/* ?ticker= из ссылки сканера — автозапуск */
initAuth(function(){});
(function(){
  var m=location.search.match(/ticker=([A-Za-z0-9.\-]+)/);
  if(m){$('#tkr').value=m[1].toUpperCase();$('#goBtn').click()}
})();
