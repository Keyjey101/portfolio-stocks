'use strict';
/* ─────────────────────────────────────────────────────────────
   fx.js — общий рантейм движения v4.2 (подключается на всех
   страницах после auth.js, до страницы-скрипта).

   Ничего не знает о данных — только DOM-хореография. Правила
   языка v4: движение — исключительно transform/opacity, единая
   кривая cubic-bezier(.32,.72,0,1), всё гасится при
   prefers-reduced-motion, а контент остаётся видимым всегда
   (классы-«пряталки» вешаются только из JS и только когда
   фича точно поддерживается).
   ───────────────────────────────────────────────────────────── */
var FX=(function(){
  var REDUCED=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  var EASE='cubic-bezier(.32,.72,0,1)';
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function all(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel))}

  /* ── Catmull-Rom → кубические Безье: строгая плавная кривая ── */
  function smoothPath(pts){
    if(!pts||pts.length<2)return '';
    function f(p){return p[0].toFixed(1)+','+p[1].toFixed(1)}
    if(pts.length===2)return 'M'+f(pts[0])+'L'+f(pts[1]);
    var d='M'+f(pts[0]);
    for(var i=0;i<pts.length-1;i++){
      var p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
      d+='C'+(p1[0]+(p2[0]-p0[0])/6).toFixed(1)+','+(p1[1]+(p2[1]-p0[1])/6).toFixed(1)
        +' '+(p2[0]-(p3[0]-p1[0])/6).toFixed(1)+','+(p2[1]-(p3[1]-p1[1])/6).toFixed(1)
        +' '+f(p2);
    }
    return d;
  }

  /* ── прорисовка линии «от руки»: stroke-dashoffset → 0, один раз на path ── */
  function drawIn(root){
    if(REDUCED)return;
    all('path.spk-line:not(.drew)',root).forEach(function(p){
      var L;
      try{L=p.getTotalLength()}catch(e){return}
      if(!isFinite(L)||L<=0)return;
      p.classList.add('drew');
      p.style.strokeDasharray=String(L);
      p.style.strokeDashoffset=String(L);
      p.getBoundingClientRect(); /* фиксируем стартовое состояние */
      p.style.transition='stroke-dashoffset .9s '+EASE+' .05s';
      p.style.strokeDashoffset='0';
    });
  }

  /* ── одометр: посимвольная прокрутка числа (механика, не косметика) ──
     el.__odo хранит прошлую строку; up=true — значение выросло. */
  function odo(el,text,up){
    if(!el)return;
    var old=el.__odo;
    el.__odo=text;
    if(REDUCED||!old||old===text){el.textContent=text;return}
    el.classList.add('odo');
    if(old.length!==text.length){
      /* смена разряда — честный кроссфейд вместо кривой прокрутки */
      el.textContent=text;
      el.classList.remove('odo-x');void el.offsetWidth;el.classList.add('odo-x');
      return;
    }
    var html='',finals=[],right=text.length-1;
    for(var i=0;i<text.length;i++){
      var o=old.charAt(i),w=text.charAt(i);
      if(o===w){html+='<span class="odo-c"><span class="odo-w st">'+esc(w)+'</span></span>';continue}
      var topCh=up?o:w,botCh=up?w:o;
      var init=up?'translateY(0)':'translateY(-50%)';
      html+='<span class="odo-c"><span class="odo-w mv" style="transform:'+init+'">'
        +'<i>'+esc(topCh)+'</i><i>'+esc(botCh)+'</i></span></span>';
      finals.push({el:null,delay:(right-i)*45,up:up});
    }
    el.innerHTML=html;
    var strips=all('.odo-w.mv',el);
    for(var k=0;k<strips.length;k++)finals[k].el=strips[k];
    var applied=false;
    var apply=function(){
      if(applied)return;applied=true;
      finals.forEach(function(s){
        if(!s.el)return;
        s.el.style.transitionDelay=s.delay+'ms';
        s.el.style.transform=s.up?'translateY(-50%)':'translateY(0)';
      });
    };
    requestAnimationFrame(function(){requestAnimationFrame(apply)});
    setTimeout(apply,150); /* rAF может быть заморожен фоновой вкладкой */
    /* снятие задержек после прокрутки — чтобы :hover-переходов не было с лагом */
    setTimeout(function(){finals.forEach(function(s){if(s.el)s.el.style.transitionDelay='0ms'})},(text.length*45)+700);
  }

  /* ── появление по скролу: ниже первого экрана .reveal → .io, лаборатории — тоже ── */
  function io(){
    if(REDUCED||!('IntersectionObserver'in window))return;
    var vh=window.innerHeight,mark=[];
    all('main.wrap .reveal').forEach(function(el){
      var r=el.getBoundingClientRect();
      if(r.top>vh*0.85){el.classList.remove('reveal');el.classList.add('io');mark.push(el)}
    });
    all('main.wrap .lgroup').forEach(function(el){
      if(!el.classList.contains('io')){el.classList.add('io');mark.push(el)}
    });
    var ob=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(e.isIntersecting){e.target.classList.add('in');ob.unobserve(e.target)}
      });
    },{rootMargin:'0px 0px -8% 0px'});
    mark.forEach(function(el){ob.observe(el)});
    /* страховка: если IO-колбэки заморожены (фоновая вкладка) —
       доворачиваем .in по факту скролла геометрией */
    var pending=mark.filter(function(el){return !el.classList.contains('in')});
    var ticking=false;
    function ioSweep(){
      ticking=false;
      pending=pending.filter(function(el){
        if(el.classList.contains('in'))return false;
        var r=el.getBoundingClientRect();
        if(r.top<window.innerHeight*0.95){el.classList.add('in');ob.unobserve(el);return false}
        return true;
      });
      if(!pending.length){
        window.removeEventListener('scroll',ioSweep);
        window.removeEventListener('resize',ioSweep);
      }
    }
    function ioOnScroll(){
      if(ticking)return;ticking=true;
      requestAnimationFrame(ioSweep);
      setTimeout(ioSweep,120);
    }
    window.addEventListener('scroll',ioOnScroll,{passive:true});
    window.addEventListener('resize',ioOnScroll,{passive:true});
    /* всё, что уже на экране, — показать сразу (с мини-стаггером) */
    mark.forEach(function(el,i){
      var r=el.getBoundingClientRect();
      if(r.top<vh){el.style.transitionDelay=Math.min(i*60,180)+'ms';
        var shown=false;
        var show=function(){
          if(shown)return;shown=true;
          el.classList.add('in');
          setTimeout(function(){el.style.transitionDelay=''},700);
        };
        requestAnimationFrame(show);
        setTimeout(show,80); /* страховка от замороженного rAF */
      }
    });
  }

  /* ── бронзовый волосок прогресса чтения (топ экрана) ── */
  function sprog(){
    var b=document.createElement('div');
    b.id='sprog';b.setAttribute('aria-hidden','true');
    document.body.appendChild(b);
    var tick=false;
    function up(){
      tick=false;
      var h=document.documentElement;
      var m=h.scrollHeight-window.innerHeight;
      b.style.width=(m>4?(h.scrollTop||document.body.scrollTop)/m*100:0)+'%';
    }
    window.addEventListener('scroll',function(){
      if(!tick){tick=true;requestAnimationFrame(up)}
    },{passive:true});
    window.addEventListener('resize',function(){
      if(!tick){tick=true;requestAnimationFrame(up)}
    },{passive:true});
    up();
  }

  /* ── стаггер-появление динамически вставленных секций (результаты анализов) ── */
  function stagger(root,sel){
    if(REDUCED||!root)return;
    all(sel||'section.grp, section.bez',root).forEach(function(el,i){
      el.style.setProperty('--i',String(i));
      el.classList.add('sIn');
    });
  }

  /* ── скелетон: шиммер-строки под подписью, пока секция считает ── */
  function skel(html){
    return (html||'')+'<div class="skel-line" style="width:86%"></div><div class="skel-line" style="width:64%"></div>';
  }

  function init(){
    io();
    sprog();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();

  return {REDUCED:REDUCED,EASE:EASE,esc:esc,all:all,
    smoothPath:smoothPath,drawIn:drawIn,odo:odo,io:io,sprog:sprog,
    stagger:stagger,skel:skel};
})();
