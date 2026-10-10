/**
 * forge — the web chat page (served by web.js at /).
 *
 * One self-contained document: no external requests (the page's CSP allows
 * only this server), no build step. Everything the model writes is escaped
 * before the small Markdown renderer below turns it into HTML, and links open
 * only http(s) and mailto.
 *
 * Authoring note: the page is a String.raw template, so backslashes reach the
 * browser exactly as written. The client code therefore uses no backticks (a
 * literal backtick is written \x60) and never the dollar-brace sequence.
 */
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>forge</title>
<style>
:root{
  --bg:#EEF1F4; --panel:#F7F9FB; --surface:#FFFFFF; --sunk:#E3E8EE; --line:#D3DAE2;
  --ink:#1C2430; --muted:#5B6878; --faint:#8C97A5;
  --temper:#2C5DA3; --temper-ink:#FFFFFF; --temper-soft:#DCE6F5;
  --straw:#A87B1E; --straw-soft:#F3E7C8; --ok:#2E7A57; --err:#B0433C; --err-soft:#F6DEDB;
  --add:#E3F1E8; --del:#F8E3E1; --hunk:#E3EAF6;
  --serif:Charter,"Bitstream Charter","Sitka Text",Cambria,"Iowan Old Style",Georgia,serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Ubuntu,sans-serif;
  --mono:ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --shadow:0 1px 2px rgba(28,36,48,.06),0 8px 24px rgba(28,36,48,.08);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#1B1F25; --panel:#20252C; --surface:#262C34; --sunk:#171A1F; --line:#343C47;
  --ink:#E5E9EF; --muted:#9BA6B4; --faint:#6E7987;
  --temper:#86AEEA; --temper-ink:#14213A; --temper-soft:#24334A;
  --straw:#D8B25C; --straw-soft:#3A3220; --ok:#6CC59B; --err:#E58A82; --err-soft:#3D2624;
  --add:#1F3428; --del:#3D2624; --hunk:#22304A; --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#1B1F25; --panel:#20252C; --surface:#262C34; --sunk:#171A1F; --line:#343C47;
  --ink:#E5E9EF; --muted:#9BA6B4; --faint:#6E7987;
  --temper:#86AEEA; --temper-ink:#14213A; --temper-soft:#24334A;
  --straw:#D8B25C; --straw-soft:#3A3220; --ok:#6CC59B; --err:#E58A82; --err-soft:#3D2624;
  --add:#1F3428; --del:#3D2624; --hunk:#22304A; --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);display:flex;overflow:hidden}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--temper);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

/* sidebar */
#side{width:268px;flex:none;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.brand{display:flex;align-items:center;gap:10px;padding:16px 16px 10px}
.brand b{font:600 17px/1 var(--sans);letter-spacing:.01em}
.brand .proj{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right}
.newchat{margin:4px 12px 10px;display:flex;align-items:center;justify-content:center;gap:8px;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--surface);font-weight:550}
.newchat:hover{border-color:var(--temper)}
.search{margin:0 12px 8px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);font-size:13.5px}
#convs{flex:1;overflow:auto;padding:4px 8px 12px;min-height:0}
.conv{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;background:none;padding:8px 10px;border-radius:8px;color:var(--ink)}
.conv:hover{background:var(--sunk)}
.conv.on{background:var(--temper-soft)}
.conv .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.conv .w{color:var(--faint);font-size:11.5px}
.group{color:var(--faint);font-size:12px;padding:12px 10px 4px}
.sidefoot{border-top:1px solid var(--line);padding:8px;display:flex;flex-direction:column;gap:2px}
.sidefoot a,.sidefoot button{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;border:0;background:none;color:var(--ink);text-decoration:none;font-size:14px;text-align:left}
.sidefoot a:hover,.sidefoot button:hover{background:var(--sunk)}
.empty-list{color:var(--faint);font-size:13px;padding:12px 10px}

/* main */
#main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
header{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--bg);min-height:56px}
#menuBtn{display:none}
#title{flex:1;min-width:0;font-weight:600;font-size:15.5px;border:1px solid transparent;background:none;border-radius:6px;padding:4px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
#title:hover{border-color:var(--line)}
.hbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:6px 10px;font-size:13.5px;white-space:nowrap}
.hbtn:hover{border-color:var(--temper)}
.hbtn .n{background:var(--temper);color:var(--temper-ink);border-radius:9px;padding:0 6px;font-size:11.5px;font-weight:600}
.model{max-width:260px;overflow:hidden;text-overflow:ellipsis}
.icon{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ibtn{border:0;background:none;border-radius:8px;padding:6px;display:inline-flex;color:var(--muted)}
.ibtn:hover{background:var(--sunk);color:var(--ink)}
.menu{position:absolute;z-index:30;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:6px;min-width:220px}
.menu button{display:flex;width:100%;gap:10px;align-items:center;border:0;background:none;padding:8px 10px;border-radius:7px;text-align:left;font-size:14px}
.menu button:hover{background:var(--sunk)}
.menu .sep{height:1px;background:var(--line);margin:4px 2px}
.menu .danger{color:var(--err)}

#scroll{flex:1;overflow:auto;min-height:0}
#thread{max-width:820px;margin:0 auto;padding:28px 24px 24px}
.msg{margin:0 0 26px}
.msg.user{display:flex;flex-direction:column;align-items:flex-end}
.bubble{background:var(--surface);border:1px solid var(--line);border-radius:14px 14px 4px 14px;padding:10px 14px;max-width:85%;white-space:pre-wrap;word-wrap:break-word}
.atts{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px;justify-content:flex-end}
.att{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--panel);border-radius:9px;padding:5px 9px;font-size:12.5px;max-width:260px;color:var(--ink);text-decoration:none}
.att img{width:34px;height:34px;object-fit:cover;border-radius:5px}
.att .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.att .sz{color:var(--faint)}
.att .x{border:0;background:none;color:var(--muted);padding:0 2px;font-size:15px;line-height:1}
.att.up{opacity:.7}
.att .bar{height:3px;background:var(--temper);border-radius:2px;margin-top:3px}

.meta{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:12.5px;margin:0 0 6px}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;font-size:12px;background:var(--sunk);color:var(--muted)}
.badge.agent{background:var(--temper-soft);color:var(--temper)}
.badge.live{background:var(--straw-soft);color:var(--straw)}
.answer{font:16.5px/1.65 var(--serif);word-wrap:break-word}
.answer p{margin:0 0 .8em}
.answer h1,.answer h2,.answer h3,.answer h4{font-family:var(--sans);line-height:1.3;margin:1.2em 0 .45em}
.answer h1{font-size:1.35em}.answer h2{font-size:1.2em}.answer h3{font-size:1.07em}.answer h4{font-size:1em}
.answer ul,.answer ol{margin:0 0 .8em;padding-left:1.5em}
.answer li{margin:.2em 0}
.answer blockquote{margin:0 0 .8em;padding:2px 14px;border-left:3px solid var(--line);color:var(--muted)}
.answer a{color:var(--temper)}
.answer code{font:.86em/1.4 var(--mono);background:var(--sunk);padding:.1em .35em;border-radius:5px}
.answer hr{border:0;border-top:1px solid var(--line);margin:1.2em 0}
.answer table{border-collapse:collapse;margin:0 0 1em;font:14px/1.45 var(--sans);display:block;overflow:auto;max-width:100%}
.answer th,.answer td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
.answer th{background:var(--sunk);font-weight:600}
.code{margin:0 0 1em;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--sunk)}
.code-h{display:flex;justify-content:space-between;align-items:center;padding:4px 6px 4px 12px;font:12px var(--sans);color:var(--muted);border-bottom:1px solid var(--line)}
.code-h button{border:0;background:none;color:var(--muted);font-size:12px;padding:3px 8px;border-radius:6px}
.code-h button:hover{background:var(--surface);color:var(--ink)}
.code pre{margin:0;padding:12px 14px;overflow:auto;font:13px/1.55 var(--mono)}
.code pre code{background:none;padding:0;font:inherit}
.thinking{margin:0 0 10px;font:13px/1.5 var(--sans);color:var(--muted)}
.thinking summary{cursor:pointer}
.thinking pre{white-space:pre-wrap;font:12.5px/1.5 var(--mono);max-height:220px;overflow:auto;margin:6px 0 0}

/* the temper rail: agent activity */
.rail{position:relative;margin:0 0 14px;padding:2px 0 2px 16px;font:13px/1.45 var(--sans)}
.rail::before{content:"";position:absolute;left:3px;top:4px;bottom:4px;width:2px;border-radius:2px;background:var(--temper)}
.rail.live::before{background:linear-gradient(var(--temper),var(--straw))}
.rail summary{cursor:pointer;color:var(--muted);list-style:none}
.rail summary::-webkit-details-marker{display:none}
.rail summary .live{color:var(--straw)}
.acts{margin:6px 0 0;padding:0;list-style:none;max-height:300px;overflow:auto}
.acts li{display:flex;gap:8px;padding:2px 0;color:var(--muted);min-width:0}
.acts li b{color:var(--ink);font-weight:550;flex:none}
.acts li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px}
.acts li.bad b{color:var(--err)}
.acts li.res span{color:var(--faint)}
.files{margin:10px 0 0;border:1px solid var(--line);border-radius:10px;background:var(--surface);font:13.5px var(--sans)}
.files .fh{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);color:var(--muted)}
.files ul{list-style:none;margin:0;padding:4px 0}
.files li{display:flex;align-items:center;gap:10px;padding:4px 12px}
.files li .st{font:600 11px var(--mono);width:18px;color:var(--muted)}
.files li a{color:var(--ink);text-decoration:none;font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files li a:hover{color:var(--temper);text-decoration:underline}
.linkbtn{border:0;background:none;color:var(--temper);font-size:13px;padding:2px 4px}
.note{color:var(--straw);font:13px var(--sans);margin:6px 0 0}
.err{color:var(--err);background:var(--err-soft);border-radius:8px;padding:8px 12px;font:13.5px var(--sans);margin:8px 0 0}
.actions{display:flex;gap:2px;margin:6px 0 0;opacity:.75}
.actions button{border:0;background:none;color:var(--muted);font-size:12.5px;padding:3px 8px;border-radius:6px}
.actions button:hover{background:var(--sunk);color:var(--ink)}
.cursor::after{content:"";display:inline-block;width:.5em;height:1em;vertical-align:-.12em;background:var(--temper);margin-left:2px;animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}

/* empty state */
.welcome{max-width:640px;margin:10vh auto 0;padding:0 24px}
.welcome h1{font:600 26px/1.25 var(--sans);margin:0 0 8px;letter-spacing:-.01em}
.welcome p{color:var(--muted);margin:0 0 22px}
.starts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.start{border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:12px 14px;text-align:left}
.start:hover{border-color:var(--temper)}
.start b{display:block;font-weight:550;margin-bottom:2px}
.start span{color:var(--muted);font-size:13.5px}

/* composer */
#composerWrap{padding:0 24px 18px}
#composer{max-width:820px;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:10px 10px 8px}
#composer.drag{border-color:var(--temper);background:var(--temper-soft)}
#chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 4px 8px}
#chips:empty{display:none}
#input{width:100%;border:0;background:none;resize:none;outline:none;padding:4px 6px;max-height:40vh;min-height:26px;font-size:15.5px;line-height:1.5}
.crow{display:flex;align-items:center;gap:8px;padding:6px 2px 0}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.seg button{border:0;background:none;padding:5px 11px;font-size:13px;color:var(--muted)}
.seg button[aria-pressed="true"]{background:var(--temper);color:var(--temper-ink)}
.toggle{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:9px;padding:4px 10px;background:none}
.toggle[aria-pressed="true"]{color:var(--temper);border-color:var(--temper)}
.grow{flex:1}
#send{border:0;border-radius:10px;background:var(--temper);color:var(--temper-ink);padding:7px 16px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
#send:disabled{opacity:.45;cursor:default}
#send.stop{background:var(--ink);color:var(--bg)}
.hint{max-width:820px;margin:6px auto 0;color:var(--faint);font-size:12px;text-align:center}

/* drawer + dialog */
#drawer{position:absolute;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow);transform:translateX(100%);transition:transform .2s ease;z-index:20;display:flex;flex-direction:column}
#drawer.open{transform:none}
.dh{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
.dh h2{font-size:15px;margin:0;flex:1}
.db{overflow:auto;padding:12px 14px;flex:1}
.diff{font:12px/1.5 var(--mono);white-space:pre;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 0;margin-top:12px}
.diff div{padding:0 12px}
.diff .a{background:var(--add)}.diff .d{background:var(--del)}.diff .h{background:var(--hunk);color:var(--muted)}.diff .f{font-weight:600;padding-top:6px}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);padding:0;width:min(720px,94vw);max-height:88vh;box-shadow:var(--shadow)}
dialog::backdrop{background:rgba(20,26,34,.45)}
.dlg{display:flex;flex-direction:column;max-height:88vh}
.tabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid var(--line)}
.tabs button{border:0;background:none;padding:8px 12px;border-bottom:2px solid transparent;color:var(--muted);font-size:14px}
.tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--temper)}
.pane{padding:16px 18px;overflow:auto}
.field{margin:0 0 16px}
.field label{display:block;font-weight:550;font-size:13.5px;margin-bottom:5px}
.field .help{color:var(--muted);font-size:12.5px;margin-top:4px}
.in,select.in{width:100%;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:8px 10px;font-size:14px}
.row{display:flex;gap:8px;align-items:center}
.row .in{flex:1}
.btn{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:7px 12px;font-size:13.5px;white-space:nowrap;color:var(--ink);text-decoration:none}
.btn:hover{border-color:var(--temper)}
.btn.primary{background:var(--temper);color:var(--temper-ink);border-color:var(--temper);font-weight:600}
.prov{border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:10px 12px;margin:0 0 8px}
.prov .top{display:flex;align-items:center;gap:8px}
.prov .top b{flex:1}
.ok{color:var(--ok)}.no{color:var(--err)}
.choice{display:flex;gap:8px;flex-wrap:wrap}
.choice label{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:9px;padding:6px 10px;font-weight:400;cursor:pointer;background:var(--surface)}
.chk{display:flex;gap:8px;align-items:flex-start;font-weight:400!important}
.dfoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--line)}
#toasts{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:50;pointer-events:none}
.toast{background:var(--ink);color:var(--bg);border-radius:10px;padding:9px 14px;font-size:13.5px;box-shadow:var(--shadow);max-width:80vw}
.toast.bad{background:var(--err);color:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}

@media (max-width:860px){
  #side{position:fixed;inset:0 auto 0 0;z-index:40;transform:translateX(-100%);transition:transform .2s ease;box-shadow:var(--shadow)}
  body.side-open #side{transform:none}
  #menuBtn{display:inline-flex}
  .model{max-width:120px}
  #thread{padding:20px 14px}
  #composerWrap{padding:0 10px 10px}
  .hide-sm,.hint{display:none}
  .seg button{padding:5px 8px}
  .toggle{padding:4px 8px}
  .crow{gap:6px}
  #send{padding:7px 12px}
}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-clip" viewBox="0 0 24 24"><path d="M21 11.5 12.6 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.6a1.7 1.7 0 0 1-2.4-2.4L15.5 7.5"/></symbol>
  <symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></symbol>
  <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></symbol>
  <symbol id="i-dots" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="i-files" viewBox="0 0 24 24"><path d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></symbol>
  <symbol id="i-anvil" viewBox="0 0 24 24"><path d="M3 7h13a5 5 0 0 0 5-2v4a4 4 0 0 1-4 3h-1v2l3 3v2H5v-2l3-3v-2H7a4 4 0 0 1-4-4z"/></symbol>
</svg>

<aside id="side" aria-label="Conversations">
  <div class="brand"><svg class="icon" style="width:20px;height:20px;color:var(--temper)"><use href="#i-anvil"/></svg><b>forge</b><span class="proj" id="proj" title=""></span></div>
  <button class="newchat" id="newChat"><svg class="icon"><use href="#i-plus"/></svg>New chat</button>
  <input class="search" id="search" type="search" placeholder="Search chats" aria-label="Search chats">
  <nav id="convs"></nav>
  <div class="sidefoot">
    <button id="openSettings"><svg class="icon"><use href="#i-gear"/></svg>Settings</button>
    <a id="workspaceLink" href="#" target="_blank" rel="noopener"><svg class="icon"><use href="#i-grid"/></svg>Workspace and queue</a>
  </div>
</aside>

<main id="main">
  <header>
    <button class="ibtn" id="menuBtn" aria-label="Show chats"><svg class="icon"><use href="#i-menu"/></svg></button>
    <button id="title" title="Rename">New chat</button>
    <button class="hbtn model" id="modelBtn" title="Model — change it in Settings"></button>
    <button class="hbtn hide-sm" id="changesBtn" title="Files changed in this project"><svg class="icon"><use href="#i-files"/></svg>Changes <span class="n" id="changesN" hidden>0</span></button>
    <button class="ibtn" id="moreBtn" aria-label="More: export, rename, delete"><svg class="icon"><use href="#i-dots"/></svg></button>
  </header>
  <div id="scroll"><div id="thread"></div></div>
  <div id="composerWrap">
    <form id="composer" autocomplete="off">
      <div id="chips"></div>
      <label class="sr" for="input">Message</label>
      <textarea id="input" rows="1" placeholder="Ask anything, or tell forge what to change"></textarea>
      <div class="crow">
        <button type="button" class="ibtn" id="attach" title="Attach files (or drop / paste them)"><svg class="icon"><use href="#i-clip"/></svg></button>
        <input type="file" id="file" multiple hidden>
        <div class="seg" role="group" aria-label="How forge answers">
          <button type="button" data-mode="auto" title="forge decides: a chat answer, or the agent when you ask it to change or run something">Auto</button>
          <button type="button" data-mode="chat" title="A streamed answer, no tools">Chat</button>
          <button type="button" data-mode="agent" title="The agent: reads, edits and runs things in the project">Agent</button>
        </div>
        <button type="button" class="toggle" id="deep" aria-pressed="false" title="Think longer before answering">Deep</button>
        <span class="grow"></span>
        <button id="send" type="submit" disabled><span id="sendLabel">Send</span><svg class="icon"><use href="#i-send"/></svg></button>
      </div>
    </form>
    <div class="hint">Enter sends · Shift+Enter adds a line · Esc stops · files up to 50 MB</div>
  </div>
  <aside id="drawer" aria-label="Changes">
    <div class="dh"><h2>Changes in this project</h2>
      <a class="btn" id="dlPatch" href="#">.patch</a><a class="btn" id="dlZip" href="#">.zip</a>
      <button class="ibtn" id="closeDrawer" aria-label="Close"><svg class="icon"><use href="#i-x"/></svg></button></div>
    <div class="db" id="drawerBody"></div>
  </aside>
</main>

<dialog id="settings" aria-label="Settings"><div class="dlg">
  <div class="tabs" role="tablist">
    <button role="tab" data-tab="model" aria-selected="true">Model</button>
    <button role="tab" data-tab="keys" aria-selected="false">Providers and keys</button>
    <button role="tab" data-tab="behaviour" aria-selected="false">Behaviour</button>
    <button role="tab" data-tab="look" aria-selected="false">Appearance</button>
  </div>
  <div class="pane" id="pane"></div>
  <div class="dfoot"><button class="btn" id="closeSettings">Close</button></div>
</div></dialog>

<div id="toasts" role="status" aria-live="polite"></div>

<script>
(function(){
"use strict";
var TOKEN = __FORGE_TOKEN__;
var $ = function(id){ return document.getElementById(id) };
var S = { cwd:"", settings:null, list:[], current:null, busy:false, mode:"auto", deep:false, pending:[], uploading:0, controller:null, filter:"" };
var store = { get:function(k,d){ try{ var v=localStorage.getItem("forge."+k); return v===null?d:JSON.parse(v) }catch(e){ return d } }, set:function(k,v){ try{ localStorage.setItem("forge."+k, JSON.stringify(v)) }catch(e){} } };

// ---- tiny helpers --------------------------------------------------------
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c] }) }
function h(tag, attrs, html){ var e=document.createElement(tag); if(attrs) for(var k in attrs){ if(k==="class") e.className=attrs[k]; else if(k==="text") e.textContent=attrs[k]; else e.setAttribute(k,attrs[k]) } if(html!=null) e.innerHTML=html; return e }
function size(n){ if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(n<10240?1:0)+" KB"; return (n/1048576).toFixed(1)+" MB" }
function ago(t){ if(!t) return ""; var s=(Date.now()-t)/1000; if(s<60) return "now"; if(s<3600) return Math.floor(s/60)+"m"; if(s<86400) return Math.floor(s/3600)+"h"; return Math.floor(s/86400)+"d" }
function q(path){ return path+(path.indexOf("?")<0?"?":"&")+"t="+encodeURIComponent(TOKEN) }
function toast(msg, bad){ var t=h("div",{class:"toast"+(bad?" bad":""),text:msg}); $("toasts").appendChild(t); setTimeout(function(){ t.remove() }, bad?6000:2600) }
function api(path, opts){
  opts=opts||{}; var headers={"x-forge-token":TOKEN};
  if(opts.body!==undefined){ headers["content-type"]="application/json" }
  return fetch(path,{method:opts.method||(opts.body!==undefined?"POST":"GET"),headers:headers,body:opts.body!==undefined?JSON.stringify(opts.body):undefined})
    .then(function(r){ return r.json().catch(function(){ return {} }).then(function(j){ if(!r.ok) throw new Error(j.error||("HTTP "+r.status)); return j }) })
}

// ---- markdown (escaped first; links http(s)/mailto only) ---------------------
var LI=/^(\s*)([-*+]|\d+[.)])\s+/;
function ind(l){ return (/^\s*/.exec(l)[0]).replace(/\t/g,"    ").length }
function inl(s){
  var codes=[];
  s=String(s).replace(/(\x60+)([\s\S]*?[^\x60])\1(?!\x60)/g,function(_,a,c){ codes.push(c); return "\u0000"+(codes.length-1)+"\u0000" });
  s=esc(s);
  var links=[];
  s=s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,function(_,t,u){ var url=u.replace(/&amp;/g,"&"); if(!/^(https?:|mailto:)/i.test(url)) return t; links.push(esc(url)); return "\u0001"+(links.length-1)+"\u0002"+t+"\u0001/\u0002" });
  s=s.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/(^|[\s(])__([^_\n]+)__/g,"$1<strong>$2</strong>")
     .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g,"$1<em>$2</em>").replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g,"$1<em>$2</em>").replace(/~~([^~\n]+)~~/g,"<del>$1</del>");
  // link targets go back in last, so emphasis marks inside a URL never touch it
  s=s.replace(/\u0001(\d+)\u0002/g,function(_,n){ return '<a href="'+links[+n]+'" target="_blank" rel="noopener noreferrer">' }).replace(/\u0001\/\u0002/g,"</a>");
  return s.replace(/\u0000(\d+)\u0000/g,function(_,n){ return "<code>"+esc(codes[+n])+"</code>" });
}
function codeBlock(code, lang){ return '<div class="code"><div class="code-h"><span>'+esc(lang||"code")+'</span><button type="button" data-copy>Copy</button></div><pre><code>'+esc(code)+"</code></pre></div>" }
function startsBlock(l){ return /^\s*(\x60{3,}|~{3,})/.test(l)||/^#{1,6}\s/.test(l)||/^\s*>/.test(l)||LI.test(l)||/^\s*([-*_])(\s*\1){2,}\s*$/.test(l) }
function cells(l){ return l.trim().replace(/^\||\|$/g,"").split("|").map(function(c){ return c.trim() }) }
function md(src, depth){
  depth=depth||0;
  // quotes and lists nest by recursion: past a sane depth the rest is plain text
  if(depth>8) return "<p>"+esc(String(src||"")).replace(/\n/g,"<br>")+"</p>";
  var lines=String(src||"").replace(/\r/g,"").split("\n"), out=[], i=0;
  while(i<lines.length){
    var l=lines[i], m;
    if((m=/^\s*(\x60{3,}|~{3,})\s*([\w+#.-]*)/.exec(l))){ var fence=m[1], buf=[]; i++; while(i<lines.length && lines[i].trim().indexOf(fence)!==0){ buf.push(lines[i]); i++ } i++; out.push(codeBlock(buf.join("\n"), m[2])); continue }
    if(/^\s*$/.test(l)){ i++; continue }
    if((m=/^(#{1,6})\s+(.*)$/.exec(l))){ out.push("<h"+m[1].length+">"+inl(m[2])+"</h"+m[1].length+">"); i++; continue }
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)){ out.push("<hr>"); i++; continue }
    if(/^\s*>/.test(l)){ var qb=[]; while(i<lines.length && /^\s*>/.test(lines[i])){ qb.push(lines[i].replace(/^\s*>\s?/,"")); i++ } out.push("<blockquote>"+md(qb.join("\n"),depth+1)+"</blockquote>"); continue }
    if(/\|/.test(l) && i+1<lines.length && /\|/.test(lines[i+1]) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i+1])){
      var head=cells(l), rows=[]; i+=2; while(i<lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])){ rows.push(cells(lines[i])); i++ }
      out.push("<table><thead><tr>"+head.map(function(c){ return "<th>"+inl(c)+"</th>" }).join("")+"</tr></thead><tbody>"+rows.map(function(r){ return "<tr>"+r.map(function(c){ return "<td>"+inl(c)+"</td>" }).join("")+"</tr>" }).join("")+"</tbody></table>"); continue }
    if(LI.test(l)){
      var ordered=/\d/.test(LI.exec(l)[2]), base=ind(l), items=[];
      while(i<lines.length){
        var x=lines[i];
        if(LI.test(x) && ind(x)===base){ items.push([x.replace(LI,"")]); i++; continue }
        if(/^\s*$/.test(x)){ if(i+1<lines.length && ind(lines[i+1])>base){ items[items.length-1].push(""); i++; continue } break }
        if(ind(x)>base){ items[items.length-1].push(x.slice(Math.min(ind(x), base+4))); i++; continue }
        break
      }
      out.push((ordered?"<ol>":"<ul>")+items.map(function(it){ var b=md(it.join("\n"),depth+1); var one=/^<p>([\s\S]*?)<\/p>(?=(<[uo]l>|$))/.exec(b); return "<li>"+(one?one[1]+b.slice(one[0].length):b)+"</li>" }).join("")+(ordered?"</ol>":"</ul>")); continue }
    var p=[l]; i++; while(i<lines.length && !/^\s*$/.test(lines[i]) && !startsBlock(lines[i])){ p.push(lines[i]); i++ }
    out.push("<p>"+inl(p.join("\n")).replace(/\n/g,"<br>")+"</p>");
  }
  return out.join("");
}

// ---- conversations list --------------------------------------------------
function renderList(){
  var nav=$("convs"); nav.innerHTML="";
  var f=S.filter.toLowerCase(), items=S.list.filter(function(c){ return !f || String(c.title).toLowerCase().indexOf(f)>=0 });
  if(!items.length){ nav.appendChild(h("div",{class:"empty-list",text:S.list.length?"No chat matches.":"No chats yet. Your conversations in this project show up here."})); return }
  var now=Date.now(), groups=[["Today",864e5],["This week",6048e5],["Earlier",Infinity]], gi=-1;
  items.forEach(function(c){
    var age=now-(c.updatedAt||0), g=0; while(age>groups[g][1]) g++;
    if(g!==gi){ gi=g; nav.appendChild(h("div",{class:"group",text:groups[g][0]})) }
    var b=h("button",{class:"conv"+(S.current&&S.current.id===c.id?" on":""),title:c.title+(c.from==="terminal"?" (started in the terminal)":"")});
    b.appendChild(h("span",{class:"t",text:c.title||"New chat"})); b.appendChild(h("span",{class:"w",text:ago(c.updatedAt)}));
    b.onclick=function(){ openConv(c.id); document.body.classList.remove("side-open") };
    nav.appendChild(b);
  });
}
function loadList(){ return api("/api/conversations").then(function(r){ S.list=r.conversations||[]; renderList() }).catch(function(e){ toast(e.message,true) }) }

// ---- the thread -------------------------------------------------------------
var STARTS=[["Explain this project","How is it organised, and where do I start?"],["Find what is broken","Run the tests and fix whatever fails."],["Read a file for me","Attach a PDF, Word or Excel file and ask about it."],["Plan a change","What would it take to add a settings page?"]];
function renderThread(){
  var th=$("thread"); th.innerHTML="";
  $("title").textContent=(S.current&&S.current.title)||"New chat";
  if(!S.current || !S.current.messages.length){
    var w=h("div",{class:"welcome"});
    w.appendChild(h("h1",{text:"What are we working on?"}));
    w.appendChild(h("p",{text:"Ask a question, attach files, or tell forge what to change in "+(S.cwd||"this project")+". Auto picks a plain answer or the agent for each message."}));
    var g=h("div",{class:"starts"});
    STARTS.forEach(function(s){ var b=h("button",{class:"start",type:"button"},"<b>"+esc(s[0])+"</b><span>"+esc(s[1])+"</span>"); b.onclick=function(){ $("input").value=s[1]; grow(); $("input").focus(); updateSend() }; g.appendChild(b) });
    w.appendChild(g); th.appendChild(w); return;
  }
  S.current.messages.forEach(function(m, i){ th.appendChild(renderMsg(m, i===S.current.messages.length-1)) });
  scrollDown(true);
}
function attChip(a, removable){
  var isImg=/^image\/(png|jpeg|gif|webp)/.test(a.mime||"")||a.kind==="image";
  var el=h(a.id&&!removable?"a":"div",{class:"att"+(a.uploading?" up":"")});
  if(a.id&&!removable){ el.href=q("/api/upload/"+a.id); el.setAttribute("download",a.name) }
  if(isImg&&a.id) { var im=h("img",{alt:"",src:q("/api/upload/"+a.id+"?inline=1")}); el.appendChild(im) }
  var t=h("span"); t.appendChild(h("div",{class:"nm",text:a.name})); t.appendChild(h("div",{class:"sz",text:size(a.bytes||0)+(a.kind&&a.kind!=="binary"?" · "+a.kind:"")+(a.truncated?" · cut to fit":"")}));
  if(a.uploading){ var bar=h("div",{class:"bar"}); bar.style.width=Math.round((a.progress||0)*100)+"%"; t.appendChild(bar) }
  el.appendChild(t);
  if(removable){ var x=h("button",{class:"x",type:"button","aria-label":"Remove "+a.name,text:"×"}); x.onclick=function(){ S.pending=S.pending.filter(function(p){ return p!==a }); renderChips(); updateSend() }; el.appendChild(x) }
  if(a.note&&!removable) el.title=a.note;
  return el;
}
function renderMsg(m, last){
  var wrap=h("div",{class:"msg "+m.role});
  if(m.role==="user"){
    if(m.attachments&&m.attachments.length){ var at=h("div",{class:"atts"}); m.attachments.forEach(function(a){ at.appendChild(attChip(a,false)) }); wrap.appendChild(at) }
    if(m.text) wrap.appendChild(h("div",{class:"bubble",text:m.text}));
    return wrap;
  }
  var meta=h("div",{class:"meta"});
  if(m.mode) meta.appendChild(h("span",{class:"badge"+(m.mode==="agent"?" agent":"")+(m.live?" live":""),title:m.why||"",text:m.mode==="agent"?"Agent":"Chat"}));
  if(m.model) meta.appendChild(h("span",{text:m.model}));
  if(m.at) meta.appendChild(h("span",{text:new Date(m.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}));
  wrap.appendChild(meta);
  if(m.thinking){ var d=h("details",{class:"thinking"}); d.appendChild(h("summary",{text:"Thinking"})); d.appendChild(h("pre",{text:m.thinking})); wrap.appendChild(d) }
  if(m.activity&&m.activity.length || (m.live&&m.mode==="agent")){
    var r=h("details",{class:"rail"+(m.live?" live":"")}); if(m.live) r.open=true;
    var tools=(m.activity||[]).filter(function(a){ return a.kind==="tool" }).length;
    r.appendChild(h("summary",null,m.live?'<span class="live">Working…</span> '+tools+" step"+(tools===1?"":"s")+" so far":tools+" step"+(tools===1?"":"s")+" · show the work"));
    var ul=h("ul",{class:"acts"});
    (m.activity||[]).forEach(function(a){
      var li=h("li",{class:(a.kind==="result"?"res":"")+(a.kind==="result"&&a.ok===false?" bad":"")});
      li.appendChild(h("b",{text:a.kind==="tool"?a.name:a.kind==="result"?(a.ok===false?"✗":"✓"):a.kind==="plan"?"plan":"·"}));
      li.appendChild(h("span",{text:a.detail||""})); ul.appendChild(li);
    });
    r.appendChild(ul); wrap.appendChild(r);
  }
  var ans=h("div",{class:"answer"+(m.live&&m.mode!=="agent"?" cursor":"")}, md(m.text||""));
  if(m.live && !m.text && m.mode!=="agent") ans.innerHTML="<p></p>";
  wrap.appendChild(ans);
  if(m.files&&m.files.length){
    var fb=h("div",{class:"files"});
    var fh=h("div",{class:"fh"},"<span>"+m.files.length+" file"+(m.files.length===1?"":"s")+" changed</span>");
    var rv=h("button",{class:"linkbtn",type:"button",text:"Review changes"}); rv.onclick=openDrawer; fh.appendChild(rv); fb.appendChild(fh);
    var ul2=h("ul"); m.files.forEach(function(f){ var li=h("li"); li.appendChild(h("span",{class:"st",text:f.status==="added"?"A":f.status==="deleted"?"D":f.status==="reverted"?"R":"M"})); if(f.status==="deleted"){ li.appendChild(h("span",{text:f.path})) } else { var a=h("a",{href:q("/api/file?path="+encodeURIComponent(f.path)),title:"Download "+f.path,text:f.path}); a.setAttribute("download",""); li.appendChild(a) } ul2.appendChild(li) });
    fb.appendChild(ul2); wrap.appendChild(fb);
  }
  if(m.note) wrap.appendChild(h("div",{class:"note",text:m.note}));
  if(m.error) wrap.appendChild(h("div",{class:"err",text:m.error==="stopped"?"Stopped.":m.error}));
  if(!m.live){
    var act=h("div",{class:"actions"});
    var cp=h("button",{type:"button",text:"Copy"}); cp.onclick=function(){ copy(m.text||"") }; act.appendChild(cp);
    if(last){ var rt=h("button",{type:"button",text:"Retry"}); rt.onclick=retry; act.appendChild(rt) }
    wrap.appendChild(act);
  }
  return wrap;
}
function copy(text){ (navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).then(function(){ toast("Copied") }).catch(function(){ toast("Copy is not available in this browser",true) }) }
var stick=true;
$("scroll").addEventListener("scroll",function(){ var s=$("scroll"); stick=s.scrollHeight-s.scrollTop-s.clientHeight<80 });
function scrollDown(force){ var s=$("scroll"); if(force||stick) s.scrollTop=s.scrollHeight }
document.addEventListener("click",function(e){ var b=e.target.closest&&e.target.closest("[data-copy]"); if(b){ copy(b.closest(".code").querySelector("code").textContent) } });

function openConv(id){
  if(S.busy){ toast("Wait for the answer, or stop it first",true); return }
  return api("/api/conversations/"+encodeURIComponent(id)).then(function(c){ S.current=c; store.set("last",c.id); renderList(); renderThread() }).catch(function(e){ toast(e.message,true) });
}
function newChat(){
  if(S.busy){ toast("Wait for the answer, or stop it first",true); return }
  return api("/api/conversations",{method:"POST",body:{}}).then(function(c){ S.current={id:c.id,title:"New chat",messages:[]}; store.set("last",null); renderList(); renderThread(); $("input").focus() });
}

// ---- composer -------------------------------------------------------------
function grow(){ var t=$("input"); t.style.height="auto"; t.style.height=Math.min(t.scrollHeight, window.innerHeight*0.4)+"px" }
function updateSend(){
  var b=$("send");
  if(S.busy){ b.disabled=false; b.classList.add("stop"); $("sendLabel").textContent="Stop"; return }
  b.classList.remove("stop"); $("sendLabel").textContent="Send";
  b.disabled=S.uploading>0 || (!$("input").value.trim() && !S.pending.length);
}
function setMode(m){ S.mode=m; [].forEach.call(document.querySelectorAll(".seg button"),function(b){ b.setAttribute("aria-pressed",String(b.dataset.mode===m)) }) }
function renderChips(){ var c=$("chips"); c.innerHTML=""; S.pending.forEach(function(a){ c.appendChild(attChip(a,true)) }) }
function upload(file){
  var a={name:file.name||"pasted-file",bytes:file.size,mime:file.type,uploading:true,progress:0};
  if(file.size>50*1048576){ toast(a.name+" is larger than 50 MB",true); return }
  S.pending.push(a); S.uploading++; renderChips(); updateSend();
  var x=new XMLHttpRequest();
  x.open("POST","/api/upload"); x.setRequestHeader("x-forge-token",TOKEN); x.setRequestHeader("x-filename",encodeURIComponent(a.name)); x.setRequestHeader("content-type","application/octet-stream");
  x.upload.onprogress=function(e){ if(e.lengthComputable){ a.progress=e.loaded/e.total; renderChips() } };
  x.onload=function(){ S.uploading--; var j={}; try{ j=JSON.parse(x.responseText) }catch(e){}
    if(x.status===201){ a.id=j.id; a.name=j.name; a.bytes=j.bytes; a.mime=j.mime; a.uploading=false } else { S.pending=S.pending.filter(function(p){ return p!==a }); toast((j.error||"upload failed")+" — "+a.name,true) }
    renderChips(); updateSend() };
  x.onerror=function(){ S.uploading--; S.pending=S.pending.filter(function(p){ return p!==a }); toast("Upload failed — "+a.name,true); renderChips(); updateSend() };
  x.send(file);
}
$("attach").onclick=function(){ $("file").click() };
$("file").onchange=function(){ [].forEach.call(this.files,upload); this.value="" };
$("input").addEventListener("input",function(){ grow(); updateSend() });
$("input").addEventListener("keydown",function(e){ if(e.key==="Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); if(!S.busy) submit() } });
$("input").addEventListener("paste",function(e){ var files=[].filter.call((e.clipboardData&&e.clipboardData.files)||[],function(){ return true }); if(files.length){ e.preventDefault(); files.forEach(upload) } });
var comp=$("composer"), dragDepth=0;
window.addEventListener("dragenter",function(e){ if(e.dataTransfer&&[].indexOf.call(e.dataTransfer.types,"Files")>=0){ dragDepth++; comp.classList.add("drag") } });
window.addEventListener("dragleave",function(){ dragDepth=Math.max(0,dragDepth-1); if(!dragDepth) comp.classList.remove("drag") });
window.addEventListener("dragover",function(e){ e.preventDefault() });
window.addEventListener("drop",function(e){ e.preventDefault(); dragDepth=0; comp.classList.remove("drag"); if(e.dataTransfer) [].forEach.call(e.dataTransfer.files,upload) });
[].forEach.call(document.querySelectorAll(".seg button"),function(b){ b.onclick=function(){ setMode(b.dataset.mode) } });
$("deep").onclick=function(){ S.deep=!S.deep; this.setAttribute("aria-pressed",String(S.deep)) };
comp.addEventListener("submit",function(e){ e.preventDefault(); if(S.busy) stop(); else submit() });
document.addEventListener("keydown",function(e){ if(e.key==="Escape" && S.busy) stop() });

function stop(){ api("/api/chat/stop",{method:"POST",body:{}}).catch(function(){}); if(S.controller) setTimeout(function(){ try{ S.controller.abort() }catch(e){} },1500) }
function retry(){
  if(S.busy||!S.current) return;
  var lastUser=null; for(var i=S.current.messages.length-1;i>=0;i--){ if(S.current.messages[i].role==="user"){ lastUser=S.current.messages[i]; break } }
  if(!lastUser) return;
  // the same kind of turn again: the reply says whether it was chat or agent
  var rep=S.current.messages[S.current.messages.indexOf(lastUser)+1];
  var how=rep&&(rep.mode==="agent"||rep.mode==="chat")?"/"+rep.mode+" ":"";
  send(how+(lastUser.text||""), (lastUser.attachments||[]).filter(function(a){ return a.id }));
}
function submit(){
  var text=$("input").value; var atts=S.pending.filter(function(a){ return a.id });
  if(S.uploading>0 || (!text.trim() && !atts.length)) return;
  $("input").value=""; S.pending=[]; renderChips(); grow();
  send(text, atts);
}
function send(text, atts){
  var go=function(){
    var user={role:"user",text:text.replace(/^\/(agent|chat)\b\s*/i,"").trim(),attachments:atts.map(function(a){ return {id:a.id,name:a.name,bytes:a.bytes,mime:a.mime,kind:/^image\//.test(a.mime||"")?"image":""} }),at:Date.now()};
    var reply={role:"assistant",text:"",mode:S.mode==="auto"?null:S.mode,live:true,activity:[],at:Date.now(),model:S.settings&&S.settings.active?S.settings.active.provider+"/"+S.settings.active.model:""};
    S.current.messages.push(user,reply); S.busy=true; updateSend(); renderThread(); stick=true; scrollDown(true);
    var ansEl=function(){ var all=document.querySelectorAll("#thread .msg.assistant"); return all[all.length-1] };
    var pendingRender=false, rerender=function(full){ if(full){ var old=ansEl(); if(old) old.replaceWith(renderMsg(reply,true)); scrollDown(); return } if(pendingRender) return; pendingRender=true; requestAnimationFrame(function(){ pendingRender=false; var el=ansEl(); if(!el) return; var a=el.querySelector(".answer"); if(a) a.innerHTML=md(reply.text)||"<p></p>"; scrollDown() }) };
    S.controller=new AbortController();
    fetch("/api/chat",{method:"POST",headers:{"x-forge-token":TOKEN,"content-type":"application/json"},body:JSON.stringify({id:S.current.id,text:text,attachments:atts.map(function(a){ return a.id }),mode:S.mode,deep:S.deep}),signal:S.controller.signal})
      .then(function(r){
        if(!r.ok) return r.json().catch(function(){ return {} }).then(function(j){ throw new Error(j.error||("HTTP "+r.status)) });
        var reader=r.body.getReader(), dec=new TextDecoder(), buf="";
        var pump=function(){ return reader.read().then(function(x){
          if(x.done) return;
          buf+=dec.decode(x.value,{stream:true}); var lines=buf.split("\n"); buf=lines.pop();
          lines.forEach(function(line){ if(!line.trim()) return; var ev; try{ ev=JSON.parse(line) }catch(e){ return }
            if(ev.type==="mode"){ reply.mode=ev.mode; reply.why=ev.why; rerender(true) }
            else if(ev.type==="delta"){ reply.text+=ev.text; rerender(false) }
            else if(ev.type==="thinking"){ reply.thinking=(reply.thinking||"")+ev.text; }
            else if(ev.type==="activity"){ reply.activity.push(ev.item); rerender(true) }
            else if(ev.type==="notice"){ reply.activity.push({kind:"info",detail:ev.text}); if(reply.mode==="agent") rerender(true) }
            else if(ev.type==="error"){ reply.error=ev.error }
            else if(ev.type==="done"){ var m=ev.message; m.live=false; S.current.messages[S.current.messages.length-1]=m; reply=m; if(ev.conversation){ S.current.title=ev.conversation.title } }
          });
          return pump() }) };
        return pump();
      })
      .catch(function(e){ if(e.name!=="AbortError") reply.error=e.message; else reply.error=reply.error||"stopped" })
      .then(function(){ reply.live=false; S.busy=false; S.controller=null; updateSend(); renderThread(); loadList(); if((reply.files||[]).length) refreshChanges() });
  };
  if(!S.current){ newChat().then(go) } else go();
}

// ---- header: title, model, menu, changes --------------------------------------
$("title").onclick=function(){
  if(!S.current||!S.current.messages.length) return;
  var t=prompt("Rename this chat", S.current.title||""); if(t==null||!t.trim()) return;
  api("/api/conversations/"+encodeURIComponent(S.current.id)+"/rename",{body:{title:t}}).then(function(){ S.current.title=t.trim(); renderThread(); loadList() }).catch(function(e){ toast(e.message,true) });
};
$("modelBtn").onclick=function(){ openSettings("model") };
var menuEl=null;
function closeMenu(){ if(menuEl){ menuEl.remove(); menuEl=null } }
$("moreBtn").onclick=function(e){
  e.stopPropagation(); if(menuEl){ closeMenu(); return }
  var has=S.current&&S.current.messages.length, id=S.current&&S.current.id;
  menuEl=h("div",{class:"menu",role:"menu"}); var r=this.getBoundingClientRect(), mr=$("main").getBoundingClientRect();
  menuEl.style.top=(r.bottom-mr.top+6)+"px"; menuEl.style.right=(mr.right-r.right)+"px";
  var item=function(label, fn, cls){ var b=h("button",{type:"button",role:"menuitem",class:cls||"",text:label}); b.onclick=function(){ closeMenu(); fn() }; menuEl.appendChild(b) };
  var dl=function(fmt){ var a=h("a",{href:q("/api/export?id="+encodeURIComponent(id)+"&format="+fmt)}); a.setAttribute("download",""); document.body.appendChild(a); a.click(); a.remove() };
  if(has){
    item("Export as Markdown",function(){ dl("md") }); item("Export as HTML",function(){ dl("html") }); item("Export as JSON",function(){ dl("json") });
    item("Print or save as PDF",function(){ window.open(q("/api/export?id="+encodeURIComponent(id)+"&format=html&inline=1"),"_blank","noopener"); toast("Use your browser's Print, then Save as PDF") });
    menuEl.appendChild(h("div",{class:"sep"}));
    item("Rename",function(){ $("title").click() });
    item("Delete this chat",function(){ if(!confirm("Delete this chat? This cannot be undone.")) return; api("/api/conversations/"+encodeURIComponent(id),{method:"DELETE"}).then(function(){ toast("Chat deleted"); S.current=null; store.set("last",null); renderThread(); loadList() }).catch(function(e){ toast(e.message,true) }) },"danger");
  } else item("Nothing to export yet",function(){});
  $("main").appendChild(menuEl);
};
document.addEventListener("click",function(e){ if(menuEl&&!menuEl.contains(e.target)) closeMenu() });

function diffHtml(d){ return String(d||"").split("\n").map(function(l){ var c=/^(\+\+\+|---|diff )/.test(l)?"f":/^@@/.test(l)?"h":/^\+/.test(l)?"a":/^-/.test(l)?"d":""; return '<div class="'+c+'">'+(esc(l)||" ")+"</div>" }).join("") }
function refreshChanges(){ return api("/api/changes").then(function(d){ var n=(d.files||[]).length; $("changesN").hidden=!n; $("changesN").textContent=n; S.changes=d; return d }).catch(function(){ return null }) }
function openDrawer(){
  refreshChanges().then(function(d){
    var b=$("drawerBody"); b.innerHTML="";
    if(!d||!d.git){ b.appendChild(h("p",{text:"This folder is not a git repository, so forge cannot list what changed."})); $("dlPatch").hidden=$("dlZip").hidden=true }
    else if(!d.files.length){ b.appendChild(h("p",{text:"Nothing has changed since the last commit."})); $("dlPatch").hidden=$("dlZip").hidden=true }
    else {
      $("dlPatch").hidden=$("dlZip").hidden=false;
      var fl=h("div",{class:"files"}); var ul=h("ul");
      d.files.forEach(function(f){ var li=h("li"); li.appendChild(h("span",{class:"st",text:f.status==="??"?"A":f.status})); if(/D/.test(f.status)) li.appendChild(h("span",{text:f.path})); else { var a=h("a",{href:q("/api/file?path="+encodeURIComponent(f.path)),text:f.path,title:"Download"}); a.setAttribute("download",""); li.appendChild(a) } ul.appendChild(li) });
      fl.appendChild(ul); b.appendChild(fl);
      var df=h("div",{class:"diff"}, diffHtml(d.diff)); b.appendChild(df);
      if(d.truncated) b.appendChild(h("p",{class:"note",text:"The diff is long; it is cut here. Download the .patch for all of it."}));
    }
    $("drawer").classList.add("open");
  });
}
$("changesBtn").onclick=openDrawer;
$("closeDrawer").onclick=function(){ $("drawer").classList.remove("open") };
$("dlPatch").href=q("/api/changes.patch"); $("dlZip").href=q("/api/changes.zip");
$("dlPatch").setAttribute("download",""); $("dlZip").setAttribute("download","");

// ---- settings -------------------------------------------------------------
function showModel(){ var a=S.settings&&S.settings.active; $("modelBtn").textContent=a&&a.provider?a.provider+" / "+a.model:"Choose a model" }
function loadSettings(){ return api("/api/settings").then(function(s){ S.settings=s; showModel(); if(!S.modeInit){ S.modeInit=true; setMode(s.web&&s.web.defaultMode||"auto"); S.deep=!!(s.web&&s.web.deep); $("deep").setAttribute("aria-pressed",String(S.deep)) } return s }) }
function saveSettings(body, msg){ return api("/api/settings",{body:body}).then(function(s){ S.settings=s; showModel(); toast(msg||"Saved"); renderPane(); return true }).catch(function(e){ toast(e.message,true); return false }) }
var tab="model";
function openSettings(t){ tab=t||tab; loadSettings().then(function(){ renderPane(); var d=$("settings"); if(!d.open) d.showModal() }) }
$("openSettings").onclick=function(){ openSettings("model") };
$("closeSettings").onclick=function(){ $("settings").close() };
[].forEach.call(document.querySelectorAll(".tabs button"),function(b){ b.onclick=function(){ tab=b.dataset.tab; renderPane() } });
function field(label, inner, help){ return '<div class="field"><label>'+esc(label)+"</label>"+inner+(help?'<div class="help">'+esc(help)+"</div>":"")+"</div>" }
function renderPane(){
  [].forEach.call(document.querySelectorAll(".tabs button"),function(b){ b.setAttribute("aria-selected",String(b.dataset.tab===tab)) });
  var s=S.settings, p=$("pane"); if(!s) return;
  if(tab==="model"){
    var usable=s.providers.filter(function(x){ return x.usable });
    var cur=s.providers.filter(function(x){ return x.name===s.active.provider })[0]||usable[0]||{models:[]};
    p.innerHTML=field("Provider",'<select class="in" id="pSel">'+usable.map(function(x){ return '<option value="'+esc(x.name)+'"'+(x.name===cur.name?" selected":"")+">"+esc(x.label)+"</option>" }).join("")+"</select>", usable.length?"Only providers with a key are listed. Add one under Providers and keys.":"No provider has a key yet — add one under Providers and keys.")
      +field("Model",'<div class="row"><input class="in" id="mIn" list="mList" value="'+esc(s.active.provider===cur.name?s.active.model:cur.model||"")+'"><datalist id="mList">'+(cur.models||[]).map(function(m){ return '<option value="'+esc(m)+'">' }).join("")+'</datalist><button class="btn" id="fetchModels" type="button">Load list</button></div>',"Type any model id, or load the provider's own list.")
      +'<div class="row" style="justify-content:flex-end"><button class="btn primary" id="useModel" type="button">Use this model</button></div>';
    $("pSel").onchange=function(){ var x=s.providers.filter(function(y){ return y.name===$("pSel").value })[0]; $("mIn").value=x&&x.model||""; $("mList").innerHTML=(x&&x.models||[]).map(function(m){ return '<option value="'+esc(m)+'">' }).join("") };
    $("fetchModels").onclick=function(){ var b=this; b.disabled=true; b.textContent="Loading…"; api("/api/models?provider="+encodeURIComponent($("pSel").value)).then(function(r){ $("mList").innerHTML=(r.models||[]).map(function(m){ return '<option value="'+esc(m)+'">' }).join(""); toast(r.ok?(r.models.length+" models — start typing to pick one"):("Could not load the list: "+r.error),!r.ok) }).catch(function(e){ toast(e.message,true) }).then(function(){ b.disabled=false; b.textContent="Load list" }) };
    $("useModel").onclick=function(){ saveSettings({activeProvider:$("pSel").value,model:$("mIn").value.trim()},"Model changed") };
  } else if(tab==="keys"){
    var rows=s.providers.map(function(x){
      var st=x.keyFromEnv?'<span class="ok">key from '+esc(x.keyFromEnv)+"</span>":x.hasKey?'<span class="ok">key set '+esc(x.keyHint||"")+"</span>":'<span class="no">no key</span>';
      return '<div class="prov"><div class="top"><b>'+esc(x.label)+"</b>"+st+(x.name!==s.active.provider?' <button class="linkbtn" data-rm="'+esc(x.name)+'" type="button">Remove</button>':"")+'</div><div class="row" style="margin-top:8px"><input class="in" type="password" autocomplete="off" placeholder="'+(x.hasKey?"Replace the key":"Paste the API key")+'" data-key="'+esc(x.name)+'"><button class="btn" data-savekey="'+esc(x.name)+'" type="button">Save key</button></div></div>';
    }).join("");
    var have={}; s.providers.forEach(function(x){ have[x.name]=1 });
    var opts=s.catalog.filter(function(c){ return !have[c.name] }).map(function(c){ return '<option value="'+esc(c.name)+'">'+esc(c.label)+"</option>" }).join("");
    p.innerHTML=field("Your providers",rows||"<p>None yet.</p>","Keys are stored outside forge's folder, readable only by you, and never shown again here.")
      +field("Add a provider",'<div class="row"><select class="in" id="addSel">'+opts+'<option value="__custom">Custom (OpenAI-compatible)</option></select></div><div id="customRow" hidden style="margin-top:8px"><div class="row"><input class="in" id="cName" placeholder="name, e.g. mylab"><select class="in" id="cProto" style="flex:0 0 140px"><option value="openai">OpenAI protocol</option><option value="anthropic">Anthropic protocol</option></select></div><input class="in" id="cUrl" style="margin-top:8px" placeholder="Base URL — starts with https and usually ends in /v1"><input class="in" id="cModel" style="margin-top:8px" placeholder="Model id"></div><div class="row" style="margin-top:8px"><input class="in" type="password" id="addKey" placeholder="API key (optional for local servers)" autocomplete="off"><button class="btn primary" id="addBtn" type="button">Add</button></div>');
    $("addSel").onchange=function(){ $("customRow").hidden=this.value!=="__custom" };
    $("customRow").hidden=$("addSel").value!=="__custom";
    $("addBtn").onclick=function(){ var v=$("addSel").value, body; if(v==="__custom") body={addProvider:{name:$("cName").value.trim(),baseUrl:$("cUrl").value.trim(),protocol:$("cProto").value,model:$("cModel").value.trim(),key:$("addKey").value.trim()}}; else body={addProvider:{name:v,key:$("addKey").value.trim()}}; saveSettings(body,"Provider added") };
    [].forEach.call(p.querySelectorAll("[data-savekey]"),function(b){ b.onclick=function(){ var n=b.dataset.savekey, inp=p.querySelector('[data-key="'+n+'"]'); if(!inp.value.trim()){ toast("Paste a key first",true); return } saveSettings({apiKey:{provider:n,key:inp.value.trim()}},"Key saved for "+n) } });
    [].forEach.call(p.querySelectorAll("[data-rm]"),function(b){ b.onclick=function(){ if(confirm("Remove "+b.dataset.rm+" and its settings?")) saveSettings({removeProvider:b.dataset.rm},"Removed") } });
  } else if(tab==="behaviour"){
    var dm=s.web.defaultMode;
    p.innerHTML=field("How forge answers by default",'<div class="choice">'+[["auto","Auto"],["chat","Chat"],["agent","Agent"]].map(function(o){ return '<label><input type="radio" name="dm" value="'+o[0]+'"'+(dm===o[0]?" checked":"")+">"+o[1]+"</label>" }).join("")+"</div>","Auto gives a plain answer to questions and uses the agent when you ask it to change or run something.")
      +field("Thinking",'<label class="chk"><input type="checkbox" id="dDeep"'+(s.web.deep?" checked":"")+"> Start every chat with Deep on</label>")
      +field("Other providers",'<label class="chk"><input type="checkbox" id="fo"'+(s.failover?" checked":"")+"> Let forge move to another provider when this one fails or measures worse</label>","Off: forge stays on the provider you chose and stops when it fails.")
      +field("Attempts per agent task",'<input class="in" type="number" min="1" max="8" id="tries" value="'+esc(s.tries)+'" style="max-width:100px">',"More than 1 runs several attempts and keeps the one your tests pass (costs more).")
      +'<div class="row" style="justify-content:flex-end"><button class="btn primary" id="saveBeh" type="button">Save</button></div>';
    $("saveBeh").onclick=function(){ var m=(p.querySelector('input[name="dm"]:checked')||{}).value; saveSettings({web:{defaultMode:m,deep:$("dDeep").checked},failover:$("fo").checked,tries:Number($("tries").value)||1}).then(function(ok){ if(ok) setMode(m) }) };
  } else {
    var th=store.get("theme","system");
    p.innerHTML=field("Theme",'<div class="choice">'+[["system","Match the system"],["light","Light"],["dark","Dark"]].map(function(o){ return '<label><input type="radio" name="th" value="'+o[0]+'"'+(th===o[0]?" checked":"")+">"+o[1]+"</label>" }).join("")+"</div>")
      +field("About",'<p style="margin:0">forge '+esc(s.version||"")+" · working in "+esc(S.cwd)+"</p>");
    [].forEach.call(p.querySelectorAll('input[name="th"]'),function(r){ r.onchange=function(){ store.set("theme",r.value); applyTheme() } });
  }
}
function applyTheme(){ var t=store.get("theme","system"); if(t==="system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme",t) }

// ---- start ----------------------------------------------------------------------
$("newChat").onclick=newChat;
$("search").oninput=function(){ S.filter=this.value; renderList() };
$("menuBtn").onclick=function(){ document.body.classList.toggle("side-open") };
$("workspaceLink").href=q("/workspace");
applyTheme(); setMode("auto"); updateSend();
Promise.all([api("/state").catch(function(){ return {} }), loadSettings().catch(function(e){ toast(e.message,true) }), loadList()]).then(function(r){
  S.cwd=(r[0]&&r[0].cwd)||""; $("proj").textContent=S.cwd.split(/[\/]/).filter(Boolean).pop()||S.cwd; $("proj").title=S.cwd;
  var last=store.get("last",null);
  if(last && S.list.some(function(c){ return c.id===last })) openConv(last); else renderThread();
  refreshChanges();
  if(S.settings && !S.settings.providers.some(function(x){ return x.usable })) openSettings("keys");
});
})();
</script>
</body>
</html>`

/** The chat app page, with this server's token. */
export function appHtml({ token }) {
  const lit = JSON.stringify(String(token)).replace(/</g, "\\u003c")
  return PAGE.replace("__FORGE_TOKEN__", () => lit) // a function: "$&" in a token stays literal
}
