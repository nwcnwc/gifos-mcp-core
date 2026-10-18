// Settings → AI models, for a store app. install() takes a store slug.
// assign() points a role at an app already in the Providers folder.
// This process is the host that embeds the headless GifOS, so it can answer
// tts and stt itself. It has no text model. The page calls one Playwright binding.
// It does not fetch those roles, and no sandboxed provider GIF is mounted
// for them. A raw URL and the key never go to Meet Bot.

import { MCP_TTS_APP, KOKORO_VOICE } from './settings.js';
import { QUESTION_RE, WAKE_RE } from './wake.js';
import { nativeVoice } from './voices.js';
import { HALLUCINATION_PHRASES, LOW_ENERGY } from './hallucination.js';

export const CORS_PROXY = 'https://cors-proxy.gifos.app/';
// One Playwright binding for every role this process serves. The page
// passes a role and a JSON request. It does not fetch.
export const HOST_BINDING = '__gifosHostCall';

export function hostRoles(cfg) {
  const voice = (cfg && cfg.voice) || {};
  const tts = voice.tts || {};
  const roles = [];
  if (tts.source === 'mcp' || tts.engine === 'http') roles.push('tts');
  if (voice.sttUrl && !voice.sttApp) roles.push('stt');
  return roles;
}

function endpoint(row) {
  const out = {};
  if (!row) return out;
  if (row.url) out.url = row.url;
  if (row.model) out.model = row.model;
  if (row.key) out.key = row.key;
  if (row.voice) out.voice = row.voice;
  return out;
}

// What to install and assign on a fresh profile, in Settings order.
// Kokoro is installed even when conversation voice is off, because a spoken
// line still uses the assigned text-to-speech provider.
export function installPlan(cfg) {
  const voice = (cfg && cfg.voice) || {};
  const tts = voice.tts || {};
  const hosted = new Set(hostRoles(cfg));
  const steps = [];
  if (!hosted.has('stt')) {
    if (cfg && cfg.sttApp) steps.push({ role: 'stt', appId: cfg.sttApp });
    else if (voice.sttUrl) steps.push({ role: 'stt', endpoint: endpoint({ url: voice.sttUrl }) });
  }
  if (!hosted.has('tts')) {
    if (tts.engine === 'http') steps.push({ role: 'tts', endpoint: endpoint(tts) });
    else if (tts.source === 'store' && tts.app) steps.push({ role: 'tts', appId: tts.app });
  }
  return steps;
}

function pageOf(pageUrl) {
  try { return new URL(pageUrl); } catch (e) { return null; }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// An https page must not fetch an http model itself: mixed content is blocked,
// and those endpoints do not answer a CORS preflight. The GifOS CORS proxy is
// the host path that keeps the browser call same-origin to an https service.
// https endpoints are left direct, so a key to that host is not sent elsewhere.
// An http page talking to localhost stays direct (a local computer, no mixed content).
export function fetchPlan(target, pageUrl) {
  const page = pageOf(pageUrl);
  let dest = null;
  try { dest = new URL(target); } catch (e) { dest = null; }
  const pageHttps = !!(page && page.protocol === 'https:');
  const destHttp = !!(dest && dest.protocol === 'http:');
  const local = !!(dest && isLocalHost(dest.hostname));
  const crossHttp = !!(destHttp && dest && page && !local && dest.origin !== page.origin);
  if ((pageHttps && destHttp) || crossHttp) {
    return { proxy: true, url: CORS_PROXY, headers: { 'x-gifos-target': String(target) } };
  }
  return { proxy: false, url: String(target), headers: {} };
}

// Turn provider names into what the host voice engine stores.
// An assigned app becomes gifos-provider://<role>. There is no text model:
// a settings object that names one is passed on without it.
export function expandForHost(settings, ai, hosted) {
  const next = settings ? JSON.parse(JSON.stringify(settings)) : {};
  const config = ai || {};
  const own = new Set(hosted || []);
  delete next.llm;
  if (next.tts) {
    const row = config[next.tts.provider || 'tts'] || {};
    const engine = String(next.tts.engine || (row.url ? 'http' : 'kokoro'));
    if (engine === 'none') next.tts = { engine: 'none' };
    else if (engine === 'http') {
      const url = next.tts.url || row.url || '';
      next.tts = { engine: 'http', voice: String(next.tts.voice || row.voice || '') };
      if (url) next.tts.url = String(url);
    } else {
      next.tts = {
        engine: 'kokoro',
        app: String(next.tts.app || row.appId || MCP_TTS_APP),
        voice: String(next.tts.voice || 'af_heart'),
      };
    }
  }
  if (next.stt) next.stt = {};
  if (own.has('tts') && next.tts && next.tts.engine !== 'none') {
    next.tts = {
      engine: 'kokoro',
      app: String(next.tts.app || 'gifos-mcp'),
      voice: String(next.tts.voice || 'af_heart'),
    };
  }
  return next;
}

// The bytes Kokoro produced, in the shape GifOS.providers.call('tts') returns.
export async function speakAsTts(engine, req) {
  if (!engine || typeof engine.speak !== 'function') throw new Error('Kokoro is not available on this computer.');
  const text = String((req && req.text) || '').trim();
  if (!text) throw new Error('Nothing to say.');
  const fallback = String(engine.voice || KOKORO_VOICE);
  const has = typeof engine.hasVoice === 'function'
    ? (name) => !!engine.hasVoice(name)
    : (engine.voices && typeof engine.voices === 'object' ? (name) => !!engine.voices[name] : (name) => name === fallback);
  const voice = nativeVoice((req && req.voice) || '', fallback, has);
  const bytes = Buffer.from(await engine.speak(text, voice));
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Kokoro did not return a WAV.');
  }
  return { role: 'tts', appId: engine.appId || MCP_TTS_APP, mime: 'audio/wav', bytes, voice };
}

// Runs on the GifOS host page, before host-voice.js assigns window.HostVoice.
// hostRoles: roles this process answers through one Playwright binding.
// assigned(role) is { host: true } for those roles, not a provider GIF.
// call(role) sends the request to the binding and does not fetch.
export function bridgeScript(opts) {
  const allow = new Set(['tts', 'stt']);
  const roles = [];
  for (const role of (opts && opts.hostRoles) || []) {
    if (allow.has(role) && !roles.includes(role)) roles.push(role);
  }
  const host = {};
  for (const role of roles) host[role] = true;
  const hostLit = JSON.stringify(host);
  const bindLit = JSON.stringify(HOST_BINDING);
  const arm = roles.length
    ? 'function arm(){\n' +
      '  var g=window.GifOS; var p=g&&g.providers;\n' +
      '  if(!p){ setTimeout(arm, 30); return; }\n' +
      '  if(p.__gifosHost) return;\n' +
      '  var origCall=p.call.bind(p);\n' +
      '  var origAssigned=p.assigned?p.assigned.bind(p):function(){return null;};\n' +
      '  function asBytes(v){\n' +
      '    if(v==null) return null;\n' +
      '    if(typeof ArrayBuffer!=="undefined"&&ArrayBuffer.isView&&ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);\n' +
      '    if(Object.prototype.toString.call(v)==="[object ArrayBuffer]") return new Uint8Array(v);\n' +
      '    return null;\n' +
      '  }\n' +
      '  function b64(bytes){\n' +
      '    var s="", i, n=bytes.length, chunk=0x8000, sub;\n' +
      '    for(i=0;i<n;i+=chunk){ sub=bytes.subarray(i, i+chunk>n?n:i+chunk); s+=String.fromCharCode.apply(null, sub); }\n' +
      '    return btoa(s);\n' +
      '  }\n' +
      '  function packReq(req){\n' +
      '    var out={}, k, v, bytes; req=req||{};\n' +
      '    for(k in req){ v=req[k]; bytes=asBytes(v); out[k]=bytes?b64(bytes):v; }\n' +
      '    return JSON.stringify(out);\n' +
      '  }\n' +
      '  function unpack(raw){\n' +
      '    var body=typeof raw==="string"?JSON.parse(raw):raw; body=body||{};\n' +
      '    var out={role:body.role||"", text:body.text||"", mime:body.mime||""};\n' +
      '    if(body.audio){\n' +
      '      var bin=atob(String(body.audio)); var bytes=new Uint8Array(bin.length); var i;\n' +
      '      for(i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i)&255;\n' +
      '      out.bytes=bytes;\n' +
      '    }\n' +
      '    return out;\n' +
      '  }\n' +
      '  p.assigned=function(role){\n' +
      '    if(HOST[role]) return {host:true, role:role, name:"gifos-mcp"};\n' +
      '    return origAssigned(role);\n' +
      '  };\n' +
      '  var HALL={};\n' +
      '  var HALL_LIST=' + JSON.stringify(HALLUCINATION_PHRASES) + ';\n' +
      '  for(var hi=0;hi<HALL_LIST.length;hi++) HALL[HALL_LIST[hi]]=1;\n' +
      '  function normLine(text){ return String(text||"").toLowerCase().replace(/[,.!?;:]+/g," ").replace(/\\s+/g," ").trim(); }\n' +
      '  function pcmEnergy(raw){\n' +
      '    var bytes=asBytes(raw);\n' +
      '    if(!bytes) return null;\n' +
      '    if(!bytes.length) return 0;\n' +
      '    var start=0, end=bytes.length, o, id, size, n, i, sum, v, found=false;\n' +
      '    if(bytes.length>=12 && bytes[0]===82 && bytes[1]===73 && bytes[2]===70 && bytes[3]===70 && bytes[8]===87 && bytes[9]===65 && bytes[10]===86 && bytes[11]===69){\n' +
      '      o=12;\n' +
      '      while(o+8<=bytes.length){\n' +
      '        id=String.fromCharCode(bytes[o],bytes[o+1],bytes[o+2],bytes[o+3]);\n' +
      '        size=bytes[o+4]|(bytes[o+5]<<8)|(bytes[o+6]<<16)|(bytes[o+7]<<24);\n' +
      '        if(size<0) break;\n' +
      '        if(id==="data"){ start=o+8; end=Math.min(bytes.length, start+size); found=true; break; }\n' +
      '        o+=8+size+(size&1);\n' +
      '      }\n' +
      '      if(!found) return null;\n' +
      '    }\n' +
      '    n=Math.floor((end-start)/2); if(n<=0) return 0; sum=0;\n' +
      '    for(i=0;i<n;i++){ v=bytes[start+i*2]|(bytes[start+i*2+1]<<8); if(v&32768) v-=65536; if(v<0) v=-v; sum+=v; }\n' +
      '    return sum/n;\n' +
      '  }\n' +
      '  function quietStt(out, req){\n' +
      '    if(!out || typeof out.text!=="string" || !out.text) return out;\n' +
      '    if(!HALL[normLine(out.text)]) return out;\n' +
      '    var raw=req&&(req.audio!=null?req.audio:req.bytes);\n' +
      '    var energy=pcmEnergy(raw);\n' +
      '    if(energy==null || energy>=' + LOW_ENERGY + ') return out;\n' +
      '    var copy={}, k; for(k in out) copy[k]=out[k]; copy.text=""; return copy;\n' +
      '  }\n' +
      '  p.call=function(role, req){\n' +
      '    var pending;\n' +
      '    if(HOST[role]){\n' +
      '      var fn=window[' + bindLit + '];\n' +
      '      if(typeof fn!=="function") return Promise.reject(new Error("The host provider is not available."));\n' +
      '      pending=Promise.resolve(fn(role, packReq(req))).then(unpack);\n' +
      '    } else pending=origCall(role, req);\n' +
      '    if(role!=="stt") return pending;\n' +
      '    return Promise.resolve(pending).then(function(out){ return quietStt(out, req); });\n' +
      '  };\n' +
      '  p.__gifosHost=true;\n' +
      '}\n' +
      'arm();\n'
    : '';
  const wakeLit = WAKE_RE.toString();
  const questionLit = QUESTION_RE.toString();
  const fetchWrap = roles.length
    ? 'var origFetch=window.fetch;\n' +
      'window.fetch=function(url, init){\n' +
      '  var s=String(url==null?"":url);\n' +
      '  if(s.indexOf(PREFIX)!==0){\n' +
      '    if(typeof origFetch!=="function") return Promise.reject(new Error("The host provider is not available."));\n' +
      '    return origFetch.apply(window, arguments);\n' +
      '  }\n' +
      '  var role=s.slice(PREFIX.length).split("/")[0]||"tts";\n' +
      '  var fn=window[' + bindLit + '];\n' +
      '  if(typeof fn!=="function") return Promise.reject(new Error("The host provider is not available."));\n' +
      '  var body={};\n' +
      '  try{ body=JSON.parse((init&&init.body)||"{}"); }catch(e){ body={}; }\n' +
      '  var req=body||{};\n' +
      '  if(role==="tts") req={ text:String(body.input||body.text||""), voice:String(body.voice||"") };\n' +
      '  return Promise.resolve(fn(role, JSON.stringify(req))).then(function(raw){\n' +
      '    var parsed=typeof raw==="string"?JSON.parse(raw):(raw||{});\n' +
      '    var text=String(parsed.text||"");\n' +
      '    var mime=String(parsed.mime||(role==="tts"?"audio/wav":"application/json"));\n' +
      '    var bytes=null;\n' +
      '    if(parsed.audio){\n' +
      '      var bin=atob(String(parsed.audio)); bytes=new Uint8Array(bin.length); var i;\n' +
      '      for(i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i)&255;\n' +
      '    }\n' +
      '    var chat={choices:[{message:{content:text}}]};\n' +
      '    return {\n' +
      '      ok:true, status:200,\n' +
      '      headers:{get:function(n){ return String(n||"").toLowerCase()==="content-type"?mime:null; }},\n' +
      '      arrayBuffer:function(){ return Promise.resolve(bytes?bytes.buffer:new ArrayBuffer(0)); },\n' +
      '      json:function(){ return Promise.resolve(chat); },\n' +
      '      text:function(){ return Promise.resolve(JSON.stringify(chat)); }\n' +
      '    };\n' +
      '  });\n' +
      '};\n'
    : '';
  return '(function(){\n' +
    'var HOST=' + hostLit + ';\n' +
    'var PREFIX="gifos-provider://";\n' +
    'function registerHost(){\n' +
    '  var ai, role, next, cur, changed=false;\n' +
    '  try{ ai=JSON.parse(localStorage.getItem("gifos_ai_config")||"{}")||{}; }catch(e){ ai={}; }\n' +
    '  for(role in HOST){\n' +
    '    if(!HOST[role]) continue;\n' +
    '    next={ url:PREFIX+role, model:role==="tts"?"kokoro":"provider" };\n' +
    '    cur=ai[role]||{};\n' +
    '    if(cur.url!==next.url||cur.model!==next.model||cur.key||cur.app||cur.appId){ ai[role]=next; changed=true; }\n' +
    '  }\n' +
    '  if(changed){ try{ localStorage.setItem("gifos_ai_config", JSON.stringify(ai)); }catch(e){} }\n' +
    '}\n' +
    'registerHost();\n' +
    fetchWrap +
    arm +
    'var PROXY="https://cors-proxy.gifos.app/";\n' +
    'function readAi(){try{return JSON.parse(localStorage.getItem("gifos_ai_config")||"{}")||{};}catch(e){return {};}}\n' +
    'function expand(settings){\n' +
    '  var next={}; var k; settings=settings||{};\n' +
    '  for(k in settings) next[k]=settings[k];\n' +
    '  var ai=readAi();\n' +
    '  delete next.llm;\n' +
    '  if(next.tts){\n' +
    '    var trow=ai[next.tts.provider||"tts"]||{};\n' +
    '    var engine=String(next.tts.engine||(trow.url?"http":"kokoro"));\n' +
    '    if(engine==="none") next.tts={engine:"none"};\n' +
    '    else if(engine==="http"){ var u=next.tts.url||trow.url||""; next.tts={engine:"http", voice:String(next.tts.voice||trow.voice||"")}; if(u) next.tts.url=String(u); }\n' +
    '    else next.tts={engine:"kokoro", app:String(next.tts.app||trow.appId||' + JSON.stringify(MCP_TTS_APP) + '), voice:String(next.tts.voice||"af_heart")};\n' +
    '  }\n' +
    '  if(next.stt) next.stt={};\n' +
    '  if(HOST.tts&&next.tts&&next.tts.engine!=="none"){ next.tts={engine:"kokoro", app:String(next.tts.app||"gifos-mcp"), voice:String(next.tts.voice||"af_heart")}; }\n' +
    '  return next;\n' +
    '}\n' +
    'function localHost(h){return h==="localhost"||h==="127.0.0.1"||h==="[::1]";}\n' +
    'function plan(target){\n' +
    '  var page; var dest; try{page=new URL(location.href);}catch(e){page=null;}\n' +
    '  try{dest=new URL(target);}catch(e){dest=null;}\n' +
    '  var pageHttps=!!(page&&page.protocol==="https:");\n' +
    '  var destHttp=!!(dest&&dest.protocol==="http:");\n' +
    '  var local=!!(dest&&localHost(dest.hostname));\n' +
    '  var cross=!!(destHttp&&dest&&page&&!local&&dest.origin!==page.origin);\n' +
    '  if((pageHttps&&destHttp)||cross) return {proxy:true, url:PROXY, headers:{"x-gifos-target":String(target)}};\n' +
    '  return {proxy:false, url:String(target), headers:{}};\n' +
    '}\n' +
    'function sse(text){\n' +
    '  var body="data: "+JSON.stringify({choices:[{delta:{content:String(text||"")}}]})+"\\n\\n";\n' +
    '  return {ok:true, status:200, text:function(){return Promise.resolve(body);}};\n' +
    '}\n' +
    'function wrap(api){\n' +
    '  if(!api||api.__gifosProviders||typeof api.create!=="function") return api;\n' +
    '  var orig=api.create;\n' +
    '  return {\n' +
    '    __gifosProviders:true,\n' +
    '    pullClauses:api.pullClauses,\n' +
    '    scrub:api.scrub,\n' +
    '    create:function(opts){\n' +
    (roles.length ? '      arm();\n' : '') +
    '      opts=opts||{};\n' +
    '      var origFetch=opts.fetch;\n' +
    '      var next={};\n' +
    '      for(var k in opts) next[k]=opts[k];\n' +
    '      next.fetch=function(url, init){\n' +
    '        var s=String(url||"");\n' +
    '        if(s.indexOf(PREFIX)===0){\n' +
    '          var role=s.slice(PREFIX.length).split("/")[0]||"smartest";\n' +
    '          var body={}; try{body=JSON.parse((init&&init.body)||"{}");}catch(e){}\n' +
    '          var g=window.GifOS&&window.GifOS.providers;\n' +
    '          if(!g||typeof g.call!=="function") return Promise.reject(new Error("This page cannot reach the language model."));\n' +
    '          return Promise.resolve(g.call(role,{op:"chat", messages:body.messages||[]})).then(function(out){ return sse(out&&out.text); });\n' +
    '        }\n' +
    '        var p=plan(s);\n' +
    '        var headers={};\n' +
    '        var h=(init&&init.headers)||{};\n' +
    '        for(var hk in h) headers[hk]=h[hk];\n' +
    '        for(var pk in p.headers) headers[pk]=p.headers[pk];\n' +
    '        var fwd={}; for(var ik in (init||{})) fwd[ik]=init[ik];\n' +
    '        fwd.headers=headers;\n' +
    '        return origFetch(p.url, fwd);\n' +
    '      };\n' +
    '      next.tts=function(req){\n' +
    '        var g=window.GifOS&&window.GifOS.providers;\n' +
    '        if(!g||typeof g.call!=="function"||(g.assigned&&!g.assigned("tts"))) return Promise.reject(new Error("Kokoro is not available on this computer."));\n' +
    '        return g.call("tts",{text:(req&&req.text)||"", voice:(req&&req.voice)||"", app:(req&&req.app)||""});\n' +
    '      };\n' +
    '      var eng=orig.call(api, next);\n' +
    '      if(eng&&typeof eng.setVoice==="function"){\n' +
    '        var inner=eng.setVoice;\n' +
    '        eng.setVoice=function(settings){ return inner.call(eng, expand(settings)); };\n' +
    '      }\n' +
    '      return eng;\n' +
    '    }\n' +
    '  };\n' +
    '}\n' +
    'var current=window.HostVoice;\n' +
    'try{\n' +
    '  Object.defineProperty(window,"HostVoice",{configurable:true, enumerable:true,\n' +
    '    get:function(){return current;},\n' +
    '    set:function(v){current=wrap(v);}\n' +
    '  });\n' +
    '}catch(e){}\n' +
    'if(current) current=wrap(current);\n' +
    'function hears(text, name){\n' +
    '  var t=String(text||"").trim();\n' +
    '  if(!t) return false;\n' +
    '  var n=String(name||"").trim().toLowerCase();\n' +
    '  if(n && t.toLowerCase().indexOf(n)>=0) return true;\n' +
    '  return ' + wakeLit + '.test(t);\n' +
    '}\n' +
    'function asks(text){\n' +
    '  var t=String(text||"").trim();\n' +
    '  if(!t) return false;\n' +
    '  if(/\\?\\s*$/.test(t)) return true;\n' +
    '  return ' + questionLit + '.test(t);\n' +
    '}\n' +
    'function patchVoice(api){\n' +
    '  if(!api||api.__gifosWake||typeof api.isCommand!=="function") return api;\n' +
    '  var command=api.isCommand;\n' +
    '  var conversation=api.isConversation;\n' +
    '  api.isCommand=function(text, name){\n' +
    '    if(command.call(api, text, name)) return true;\n' +
    '    return hears(text, name);\n' +
    '  };\n' +
    '  api.isConversation=function(text, name){\n' +
    '    if(hears(text, name)) return false;\n' +
    '    if(typeof conversation==="function"&&conversation.call(api, text, name)) return true;\n' +
    '    return asks(text);\n' +
    '  };\n' +
    '  api.__gifosWake=true;\n' +
    '  return api;\n' +
    '}\n' +
    'var voiceNow=window.BotVoice;\n' +
    'try{\n' +
    '  Object.defineProperty(window,"BotVoice",{configurable:true, enumerable:true,\n' +
    '    get:function(){return voiceNow;},\n' +
    '    set:function(v){voiceNow=patchVoice(v);}\n' +
    '  });\n' +
    '}catch(e){}\n' +
    'if(voiceNow) voiceNow=patchVoice(voiceNow);\n' +
    '})();\n';
}
