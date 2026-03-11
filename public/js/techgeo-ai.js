/* =================================================================
   TechGeo AI — public/js/techgeo-ai.js
   All chat logic here. dashboard.html has HTML shell + toggle only.
   ================================================================= */
(function(W){'use strict';

var BOTS={
  dashboard:    {label:'TechGeo Bot',      color:'#16a34a',sub:'Platform operations'},
  blogs:        {label:'Blog Bot',          color:'#2563eb',sub:'Blog writing tips'},
  surveys:      {label:'Survey Bot',        color:'#7c3aed',sub:'Survey help'},
  writing:      {label:'Writing Bot',       color:'#d97706',sub:'Writing job tips'},
  transcription:{label:'Transcription Bot', color:'#db2777',sub:'Transcription tips'},
  dataentry:    {label:'Data Entry Bot',    color:'#0891b2',sub:'Data entry help'}
};
var NO_BOT={referrals:1,withdraw:1,profile:1,wallet:1};
var TYPE_MAP={blogs:'blog',surveys:'survey',writing:'writing',transcription:'transcription',dataentry:'dataentry',dashboard:'dashboard'};

var _page='dashboard',_history={},_greeted={},_busy=false;
var $fab,$panel,$msgs,$input,$send,$wc,$hdr,$hdrName,$hdrSub;

function getToken(){
  try{var u=localStorage.getItem('user');if(u){var p=JSON.parse(u);if(p&&p.token)return p.token;}}catch(e){}
  return localStorage.getItem('token')||'';
}
function getUsername(){
  try{var u=localStorage.getItem('user');if(u){var p=JSON.parse(u);if(p&&p.username)return p.username;}}catch(e){}
  return localStorage.getItem('username')||'there';
}
function wc(s){return s.trim().split(/\s+/).filter(Boolean).length;}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function ts(){var d=new Date();return('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);}

function bubble(text,who,tid){
  var row=document.createElement('div');
  row.className='tg-row '+(who==='me'?'tg-row-me':'tg-row-bot');
  if(tid)row.id=tid;
  var b=document.createElement('div');
  b.className='tg-bub '+(who==='me'?'tg-bub-me':'tg-bub-bot');
  b.innerHTML=esc(text).replace(/\n/g,'<br>')+'<span class="tg-ts">'+ts()+'</span>';
  row.appendChild(b);$msgs.appendChild(row);
  $msgs.scrollTop=$msgs.scrollHeight;
}
function rmTemp(id){var e=document.getElementById(id);if(e)e.remove();}

function applyBot(page){
  var bot=BOTS[page]||BOTS.dashboard;
  $hdr.style.background=bot.color;
  $hdrName.textContent=bot.label;
  $hdrSub.textContent=bot.sub;
  $fab.style.background=bot.color;
  if($send)$send.style.background=bot.color;
}

function setFabVisible(page){
  if($fab)$fab.style.display=NO_BOT[page]?'none':'flex';
}

function fetchGreeting(page,cb){
  var type=TYPE_MAP[page]||'dashboard';
  fetch('/api/ai/greeting?type='+type,{headers:{'Authorization':'Bearer '+getToken()}})
    .then(function(r){return r.json();})
    .then(function(d){cb(d.greeting||('Hello '+getUsername()+', I am TechGeo Bot.'));})
    .catch(function(){cb('Hello '+getUsername()+', I am TechGeo Bot.');});
}

function sendMsg(text){
  if(_busy)return;
  _busy=true;$send.disabled=true;$input.disabled=true;
  bubble(text,'me');
  bubble('...','bot','tg-typing');
  var type=TYPE_MAP[_page]||'dashboard';
  var hist=_history[_page]||[];
  fetch('/api/ai/chat',{
    method:'POST',
    headers:{'Authorization':'Bearer '+getToken(),'Content-Type':'application/json'},
    body:JSON.stringify({type:type,message:text,history:hist})
  })
  .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
  .then(function(res){
    rmTemp('tg-typing');
    if(!res.ok){bubble(res.d.error||'Something went wrong. Try again.','bot');}
    else{
      if(!_history[_page])_history[_page]=[];
      _history[_page].push({role:'user',content:text});
      _history[_page].push({role:'assistant',content:res.d.reply});
      if(_history[_page].length>12)_history[_page]=_history[_page].slice(-12);
      bubble(res.d.reply,'bot');
    }
  })
  .catch(function(){rmTemp('tg-typing');bubble('Network error. Check your connection.','bot');})
  .finally(function(){_busy=false;$send.disabled=false;$input.disabled=false;$input.focus();});
}

function onOpen(){
  $input.focus();
  if(!_greeted[_page]){
    _greeted[_page]=true;
    bubble('...','bot','tg-typing');
    fetchGreeting(_page,function(msg){rmTemp('tg-typing');bubble(msg,'bot');});
  }
}

function switchBot(page){
  _page=page;
  applyBot(page);
  setFabVisible(page);
  if($panel&&$panel.classList.contains('tg-open')&&!_greeted[page]){
    _greeted[page]=true;
    bubble('...','bot','tg-typing');
    fetchGreeting(page,function(msg){rmTemp('tg-typing');bubble(msg,'bot');});
  }
}

function dispatch(){
  var msg=$input.value.trim();
  if(!msg||wc(msg)>20||_busy)return;
  $input.value='';$input.style.height='auto';
  $wc.textContent='0 / 20 words';$wc.className='';$send.disabled=true;
  sendMsg(msg);
}

function init(){
  $fab=document.getElementById('tg-fab');
  $panel=document.getElementById('tg-panel');
  $msgs=document.getElementById('tg-msgs');
  $input=document.getElementById('tg-input');
  $send=document.getElementById('tg-send');
  $wc=document.getElementById('tg-wc');
  $hdr=document.getElementById('tg-hdr');
  $hdrName=document.getElementById('tg-hdr-name');
  $hdrSub=document.getElementById('tg-hdr-sub');
  if(!$fab||!$panel)return;
  applyBot('dashboard');
  $input.addEventListener('input',function(){
    this.style.height='auto';
    this.style.height=Math.min(this.scrollHeight,74)+'px';
    var n=wc(this.value),over=n>20;
    $wc.textContent=n+' / 20 words';$wc.className=over?'over':'';
    $send.disabled=over||n===0||_busy;
  });
  $input.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!$send.disabled)dispatch();}
  });
  $send.addEventListener('click',dispatch);
}

W.TechGeoAI={onOpen:onOpen,switchBot:switchBot};
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}

})(window);
