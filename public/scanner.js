'use strict';
/* Страница «Сканер сектора» (спека 07 §7.2): запуск задачи → поллинг /status
   каждые 2 с → таблица результатов с клиентской сортировкой + CSV в буфер +
   карточка ИИ-советника. Прогресс считается на клиенте (06 §6.10 → 07 §7.5). */

var $=function(s){return document.querySelector(s)};
var pollTimer=null, etaTimer=null, curRows=null, curScanType='undervalued', sortState={key:null,dir:-1};

var L={
  scanVerdict:{'STRONGLY UNDERVALUED':'СИЛЬНО НЕДООЦЕНЕНА','MODERATELY UNDERVALUED':'УМЕРЕННО НЕДООЦЕНЕНА',
    'FAIRLY VALUED':'СПРАВЕДВАЯ ЦЕНА','MODERATELY OVERVALUED':'УМЕРЕННО ПЕРЕОЦЕНЕНА','STRONGLY OVERVALUED':'СИЛЬНО ПЕРЕОЦЕНЕНА',
    'AVOID — recent material news':'ИЗБЕГАТЬ (новости)','MODERATELY UNDERVALUED (news caution)':'УМЕРЕННО НЕДООЦЕНЕНА (новостной риск)',
    'DIVIDEND CANDIDATE':'ДИВИДЕНДНЫЙ КАНДИДАТ'},
  phase:{prescreening:'прескрининг',deep_analysis:'глубокий анализ',news_radar:'радар новостей',ranking:'ранжирование',advisor:'советник',done:'готово'},
  newsLvl:{none:0,unknown:0,watch:1,elevated:2,severe:3},
  newsLvlLabel:{none:'нет',unknown:'—',watch:'наблюдение',elevated:'повышенный',severe:'критич.'}
};

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmtCur(v){return v==null?'—':'$'+(+v).toLocaleString('en-US',{maximumFractionDigits:2})}
function fmtNum(v,d){return v==null?'—':(+v).toLocaleString('en-US',{maximumFractionDigits:d==null?1:d})}
function fmtRatio(v,d){return v==null?'—':((+v)*100).toFixed(d==null?1:d)+'%'}
function fmtLarge(v){
  if(v==null)return '—';var a=Math.abs(v);
  if(a>=1e12)return (v/1e12).toFixed(2)+'T';
  if(a>=1e9)return (v/1e9).toFixed(1)+'B';
  if(a>=1e6)return (v/1e6).toFixed(1)+'M';
  if(a>=1e3)return (v/1e3).toFixed(0)+'K';
  return ''+v.toFixed(0);
}
function chip(cls,text,title){return '<span class="pill '+cls+'"'+(title?' title="'+esc(title)+'"':'')+'>'+esc(text)+'</span>'}
function verdictCls(v){
  if(String(v).indexOf('STRONGLY UNDERVALUED')===0)return 'g';
  if(String(v).indexOf('MODERATELY UNDERVALUED')===0)return 'b';
  if(String(v).indexOf('FAIRLY')===0)return 'y';
  if(String(v).indexOf('AVOID')===0)return 'r';
  return 'd';
}
function mosCls(v){return v==null?'d':v>=15?'g':v<0?'r':'y'}

/* секторы в селект */
fetch('/api/equity/sectors',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
  var sel=$('#fSector');
  (j.sectors||[]).forEach(function(s){
    var o=document.createElement('option');o.value=s;o.textContent=s;sel.appendChild(o);
  });
}).catch(function(){});

/* тип скана подсвечивает карточки */
document.querySelectorAll('input[name=scanType]').forEach(function(r){
  r.addEventListener('change',function(){
    curScanType=r.value;
    document.querySelectorAll('.eq-scan-type').forEach(function(l){l.classList.toggle('on',l.querySelector('input').checked)});
  });
});

$('#goScan').addEventListener('click',startScan);
$('#refreshBtn').addEventListener('click',startScanForce);
$('#csvBtn').addEventListener('click',copyCsv);
function startScanForce(){runScan(true)}
function startScan(){runScan(false)}

function paramsOf(force){
  return {
    scanType:curScanType,
    sector:$('#fSector').value||null,
    marketCapTier:$('#fCap').value,
    volumeTier:$('#fVol').value,
    topN:+$('#fTop').value,
    force:!!force,
  };
}

async function runScan(force){
  stopPoll();
  $('#err').textContent='';$('#results').hidden=true;$('#emptyHint').style.display='none';
  $('#goScan').disabled=true;$('#goScan').textContent='Сканируем…';
  $('#prog').hidden=false;$('#cacheNote').hidden=true;
  $('#progFill').style.width='0%';$('#progStep').textContent='запуск…';$('#progCounts').textContent='';
  progPhasesInit();
  try{
    var r=await fetch('/api/equity/scan',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(paramsOf(force))});
    if(r.status===429)throw new Error((await r.json()).error);
    if(!r.ok)throw new Error('HTTP '+r.status);
    var j=await r.json();
    var d=j.data||{};
    if(d.cached){
      loadResults(d.scanId,true);
      return;
    }
    startPolling(d.scanId,d.estimatedSeconds);
  }catch(e){
    $('#err').textContent=e.message;
    scanDone();
  }
}

function startPolling(scanId,estSec){
  etaTimer=setInterval(function(){
    var pct=progPercent();
    $('#progFill').style.width=pct.toFixed(1)+'%';
    var left=Math.max(0,(estSec||600)*(1-pct/100));
    $('#progEta').textContent=pct>1?('~'+Math.round(left)+' с осталось'):'';
  },1000);
  pollTimer=setInterval(function(){
    fetch('/api/equity/scan/'+encodeURIComponent(scanId)+'/status',{cache:'no-store'})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(j){
        var st=j.data||{};
        renderProgress(st);
        if(st.status==='completed'){stopPoll();loadResults(scanId,false)}
        if(st.status==='failed'){stopPoll();$('#err').textContent='Скан прерван: '+(st.error_message||'неизвестная ошибка');scanDone()}
      })
      .catch(function(e){
        // сетевой сбой не убивает поллинг — следующий тик попробует снова
      });
  },2000);
}
function stopPoll(){
  if(pollTimer){clearInterval(pollTimer);pollTimer=null}
  if(etaTimer){clearInterval(etaTimer);etaTimer=null}
}

function progPercent(){
  // прогресс сканера (07 §7.5): total>0 ? 50+analyzed/total*50 : fetched/universe*50
  var p=window.__lastProg||{};
  if(p.total>0)return Math.min(98,50+(p.analyzed||0)/p.total*50);
  if(p.universeSize>0)return Math.min(48,(p.fetched||0)/p.universeSize*50);
  return 3;
}
/* v4.2: чипы фаз под прогресс-трубой */
var PHASES=['prescreening','deep_analysis','news_radar','ranking','advisor'];
function progPhasesInit(){
  var el=document.getElementById('progPhases');
  if(el)el.innerHTML=PHASES.map(function(p){
    return '<span class="step" data-p="'+p+'">'+(L.phase[p]||p)+'</span>';
  }).join('');
}
function progPhaseMark(ph){
  var el=document.getElementById('progPhases');
  if(!el||!ph)return;
  var idx=PHASES.indexOf(ph);
  Array.prototype.forEach.call(el.children,function(c,i){
    c.classList.toggle('on',idx>=0&&i===idx);
    c.classList.toggle('done',(idx>=0&&i<idx)||ph==='done');
  });
}
function renderProgress(st){
  var p=st.progress||{};
  window.__lastProg=p;
  progPhaseMark(p.phase);
  var ph=L.phase[p.phase]||p.phase;
  var txt;
  if(p.phase==='prescreening')txt='Прескрининг… '+(p.fetched||0)+'/'+(p.universeSize||'?')+' тикеров · прошло фильтр '+(p.prescreened||0);
  else if(p.phase==='deep_analysis')txt='Глубокий анализ… '+(p.analyzed||0)+'/'+(p.total||'?')+' компаний'+(p.failed?' · ошибок '+p.failed:'');
  else if(p.phase==='news_radar')txt='Радар новостей…';
  else if(p.phase==='ranking')txt='Ранжирование…';
  else if(p.phase==='advisor')txt='ИИ-советник…';
  else txt=ph||'…';
  $('#progStep').textContent=txt;
  $('#progCounts').textContent='вселенная '+(p.universeSize||'—')+' · фильтр '+(p.prescreened||0)+' · проанализировано '+(p.analyzed||0)+(p.total?'/'+p.total:'')+' · ошибки '+(p.failed||0);
  $('#progFill').style.width=progPercent().toFixed(1)+'%';
}

function scanDone(){
  $('#goScan').disabled=false;$('#goScan').textContent='Запустить скан';
  setTimeout(function(){$('#prog').hidden=true},500);
}

async function loadResults(scanId,fromCache){
  try{
    var r=await fetch('/api/equity/scan/'+encodeURIComponent(scanId)+'/results',{cache:'no-store'});
    if(r.status===400){setTimeout(function(){loadResults(scanId,fromCache)},3000);return}
    if(!r.ok)throw new Error('HTTP '+r.status);
    var j=await r.json();
    var d=j.data||{};
    curRows=d.results||[];
    $('#results').hidden=false;
    $('#cacheNote').hidden=!fromCache;
    if(fromCache)$('#cacheNote').textContent='результаты из кэша (30 мин)';
    var st=d.stats||{};
    $('#stats').textContent='проанализировано '+(st.analyzed!=null?st.analyzed:curRows.length)
      +(st.undervalued!=null?' · недооценённых '+st.undervalued:'')
      +(st.failed?' · ошибок '+st.failed:'');
    renderTable();
    FX.stagger($('#results'));
    var adv=d.advisor||'';
    $('#advisorSec').hidden=!adv;
    $('#advisor').textContent=adv;
    scanDone();
  }catch(e){
    $('#err').textContent='не удалось получить результаты: '+e.message;
    scanDone();
  }
}

/* ── таблица: колонки по типу скана, клиентская сортировка ── */
var COLS_U=[
  ['#','rank'],['Ticker','ticker'],['Компания','name'],['Сектор','sector'],
  ['Цена','currentPrice','num'],['FV','valuation.fairValueWeighted','num'],['MoS %','valuation.marginOfSafety','num'],
  ['Вердикт','valuation.verdict'],['Scan','scores.scanScore','num'],['Кач./10','sectorQuality','num'],
  ['ROIC','keyMetrics.roic','num'],['CAGR3','keyMetrics.revenueCAGR3yr','num'],['P/E','keyMetrics.peTrailing','num'],
  ['FCF yld','keyMetrics.fcfYield','num'],['Pio','piotroskiF','num'],['Flags','__flags'],['News','__news']
];
var COLS_D=[
  ['#','rank'],['Ticker','ticker'],['Компания','name'],['Сектор','sector'],
  ['Цена','currentPrice','num'],['Yield','dividendYield','num'],['Payout','payoutRatio','num'],
  ['Scan','scores.scanScore','num'],['P/E','keyMetrics.peTrailing','num'],['P/B','pb','num'],
  ['ROE','roe','num'],['Маржа','profitMargin','num'],['β','beta','num'],['Новости','__newsD']
];
function getVal(r,key){
  if(key==='__flags'){
    var rf=r.redFlags||{};return {v:(rf.critical||0)*100+(rf.warnings||0),display:rf.critical+'/'+rf.warnings,title:(rf.items||[]).join('\n')};
  }
  if(key==='__news'||key==='__newsD'){
    var nr=r.newsRadar||{};
    if(key==='__newsD')return {v:0,display:'—',title:''};
    var lvl=L.newsLvl[nr.level]!=null?L.newsLvl[nr.level]:0;
    return {v:lvl,display:(L.newsLvlLabel[nr.level]||nr.level||'—'),
      title:(nr.summary||'')+((nr.items||[]).map(function(i){return '\n· '+(i.date||'')+' '+(i.headline||'')}).join(''))};
  }
  var parts=key.split('.'),v=r;
  for(var i=0;i<parts.length;i++){v=v==null?null:v[parts[i]]}
  return {v:v,display:null};
}
function renderTable(){
  var cols=curScanType==='dividend'?COLS_D:COLS_U;
  var thead='<thead><tr>'+cols.map(function(c,i){
    return '<th class="sortable'+(c[2]?' num':'')+'" data-i="'+i+'">'+esc(c[0])
      +(sortState.key===i?'<span class="arr">'+(sortState.dir<0?'↓':'↑')+'</span>':'')+'</th>';
  }).join('')+'</tr></thead>';
  var rows=curRows.map(function(r){return r}).sort(function(a,b){
    if(sortState.key==null)return (b.scores&&b.scores.scanScore||0)-(a.scores&&a.scores.scanScore||0);
    var col=cols[sortState.key];
    var va=getVal(a,col[1]),vb=getVal(b,col[1]);
    var x=va.v,y=vb.v;
    if(x==null&&y==null)return 0;
    if(x==null)return 1;   // nulls last
    if(y==null)return -1;
    if(typeof x==='string'||typeof y==='string')return String(x).localeCompare(String(y),'ru')*sortState.dir*-1;
    return (x-y)*sortState.dir*-1;
  });
  var tbody='<tbody>'+rows.map(function(r){
    var v=r.valuation||{},u=String(v.verdict||'');
    var hl=curScanType!=='dividend'&&(u.indexOf('UNDERVALUED')>=0&&u.indexOf('AVOID')<0);
    return '<tr class="'+(hl?'eq-row-hl ':'')+(r.newsQuarantine?'eq-row-quar ':'')+'">'
      +cols.map(function(c){
        var g=getVal(r,c[1]);
        var val;
        if(c[1]==='ticker')val='<a class="tk" href="/stock-analysis?ticker='+encodeURIComponent(r.ticker)+'">'+esc(r.ticker)+'</a>';
        else if(c[1]==='valuation.verdict')val=chip(verdictCls(u),L.scanVerdict[u]||u||'—');
        else if(c[1]==='valuation.marginOfSafety')val='<span class="'+mosCls(g.v)+'">'+(g.v!=null?((g.v>0?'+':'')+fmtNum(g.v,1)+'%'):'—')+'</span>';
        else if(c[1]==='valuation.fairValueWeighted')val=fmtCur(g.v);
        else if(c[1]==='currentPrice')val=fmtCur(g.v);
        else if(c[1]==='__flags')val='<span class="mut" title="'+esc(g.title)+'">'+g.display+'</span>';
        else if(c[1]==='__news')val=g.v>0?chip(g.v>=3?'r':g.v>=2?'y':'d',g.display):'<span class="mut" title="'+esc(g.title)+'">'+g.display+'</span>';
        else if(c[1]==='__newsD')val='—';
        else if(c[1]==='marketCap')val='$'+fmtLarge(g.v);
        else if(c[1]==='name')val='<span class="nt" title="'+esc(g.v)+'">'+esc(g.v)+'</span>';
        else if(c[1]==='sector')val='<span class="nt">'+esc(g.v||'—')+'</span>';
        else if(c[1]==='rank')val='<span class="mut">'+(r.rank!=null?r.rank:'·')+'</span>';
        else if(c[1]==='dividendYield'||c[1]==='payoutRatio'||c[1]==='roe'||c[1]==='profitMargin'||c[1]==='keyMetrics.roic'||c[1]==='keyMetrics.revenueCAGR3yr'||c[1]==='keyMetrics.fcfYield')val=fmtRatio(g.v);
        else if(c[1]==='piotroskiF')val=fmtNum(g.v,0);
        else if(c[1]==='pb'||c[1]==='beta')val=fmtNum(g.v,2);
        else val=g.v==null?'—':fmtNum(g.v,1);
        return '<td class="'+(c[2]?'num ':'')+(c[1]==='ticker'?'tk':'')+'">'+(val==null?'—':val)+'</td>';
      }).join('')
      +'</tr>';
  }).join('')+'</tbody>';
  $('#scanTable').innerHTML=thead+tbody;
  document.querySelectorAll('#scanTable th.sortable').forEach(function(th){
    th.addEventListener('click',function(){
      var i=+th.dataset.i;
      if(sortState.key===i)sortState.dir*=-1;else{sortState.key=i;sortState.dir=-1}
      renderTable();
    });
  });
}

/* CSV в буфер (TSV — вставляется в Excel/Sheets) */
function copyCsv(){
  if(!curRows||!curRows.length){basicToast('нечего копировать');return}
  var cols=curScanType==='dividend'?COLS_D:COLS_U;
  var lines=[cols.map(function(c){return c[0]}).join('\t')];
  curRows.forEach(function(r){
    lines.push(cols.map(function(c){
      var g=getVal(r,c[1]);
      var v=g.v;
      if(v==null)return '';
      if(typeof v==='number')return String(v);
      return String(v).replace(/\t/g,' ');
    }).join('\t'));
  });
  var txt=lines.join('\n');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){basicToast('Таблица скопирована')},function(){fbCopy(txt)});
  }else fbCopy(txt);
}
function fbCopy(txt){
  var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');basicToast('Таблица скопирована')}catch(e){basicToast('не удалось скопировать','r')}
  ta.remove();
}

initAuth(function(){});
