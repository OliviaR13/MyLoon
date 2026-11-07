/* Siri AI Bridge v1.0.0
 * Text-only adapter: Gemini, OpenAI, Anthropic, OpenAI-compatible APIs.
 * Unverified multimodal input is rejected explicitly.
 */
const VERSION = "1.0.0";
const TAG = "[siri_ai_bridge]";
const DEFAULT_PROMPT = "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。";
function getArgs() {
  let a = typeof $argument === "undefined" ? {} : $argument;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (_) { a = {}; } }
  const get = (k, d) => { const v = a[k]; if (v == null) return d; const s = String(v).trim(); return !s || /^\{.*\}$/.test(s) || s === "null" ? d : s; };
  return { provider:get("PROVIDER","openai_compatible").toLowerCase(), key:get("KEY",""), base:get("BASE","").replace(/\/+$/,""), model:get("MODEL",""), prompt:get("PROMPT",DEFAULT_PROMPT), search:get("SEARCH","false")==="true", max:Math.max(128,Math.min(8192,Number(get("MAX","2048"))||2048)) };
}
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==="x"?r:(r&3|8)).toString(16);});
function clean(t) {
  return String(t||"").replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g,m=>m.replace(/\x60\x60\x60\w*\n?/g,""))
    .replace(/^\s{0,3}#{1,6}\s+/gm,"").replace(/(\*\*|__)(.+?)\1/g,"$2")
    .replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g,"$1$2").replace(/\x60([^\x60]+)\x60/g,"$1")
    .replace(/^\s*[-*+]\s+/gm,"").replace(/\[([^\]]+)\]\(https?:[^)]+\)/g,"$1").replace(/\n{3,}/g,"\n\n").trim();
}
function summary(t){const s=String(t).replace(/\s+/g," ").trim().split(/[。！？!?\n]/)[0]||"";return s.length>20?s.slice(0,20)+"…":s;}
function parse(body){
  const messages=[];let unsupported=false;
  for(const it of body.input||[]){
    if(!it||it.type!=="message"||!it.message)continue;
    const m=it.message, blocks=Array.isArray(m.content)?m.content:[], parts=[];
    for(const c of blocks){if(c&&typeof c.text==="string"&&(!c.type||c.type==="text"||c.type==="input_text"))parts.push(c.text);else if(c&&Object.keys(c).length)unsupported=true;}
    if(!parts.length)continue;
    const role=m.role==="system"||m.role==="developer"?"system":m.role==="assistant"?"assistant":"user", content=parts.join("\n"),last=messages[messages.length-1];
    if(last&&last.role===role&&role!=="system")last.content+="\n"+content;else messages.push({role,content});
  }
  return {messages,unsupported};
}
function ev(name,data){return "event: "+name+"\ndata: "+JSON.stringify({[name]:data,type:name})+"\n\n";}
function sse(text,model,citations){
  const now=Math.floor(Date.now()/1000),sid="sess_"+uuid(),rid="resp_"+uuid().replace(/-/g,""),cid="choice_"+uuid(),value=JSON.stringify({content:text,summary:summary(text),isRequestingUserInput:false});
  const annotations=(citations||[]).map(c=>({type:"url_citation",url_citation:{index:0,title:c.title||c.url,url:c.url}}));
  const content={text:{annotations,value},type:"text"},item={type:"message",message:{role:"assistant",content:[content]}},choice={output:[item],moderation:[],id:cid,status:"completed"},p="session.response.choices[].";
  let out="";
  out+=ev("session.created",{expires_at:now+600,expires_after:{seconds:600,anchor:"last_active_at"},last_active_at:now,created_at:now,id:sid,object:"session"});
  out+=ev("session.response.created",{notices:[],session_id:sid,created_at:now,model,id:rid,choices:[],object:"session.response"});
  out+=ev(p+"added",{index:0,choice:{output:[],id:cid,status:"incomplete"}});
  out+=ev(p+"items[].added",{choice_index:0,item:{type:"message",message:{role:"assistant",content:[]}},index:0});
  out+=ev(p+"items[].message.content[].added",{item_index:0,choice_index:0,index:0,content:{text:{annotations:[],value:""},type:"text"}});
  for(let i=0;i<value.length;i+=60)out+=ev(p+"items[].message.content[].text.value.delta",{item_index:0,choice_index:0,content_index:0,delta:value.slice(i,i+60)});
  out+=ev(p+"items[].message.content[].text.value.done",{item_index:0,choice_index:0,content_index:0,value});
  annotations.forEach((a,i)=>out+=ev(p+"items[].message.content[].text.annotations[].added",{annotation:a,item_index:0,choice_index:0,content_index:0,index:i}));
  out+=ev(p+"items[].message.content[].done",{item_index:0,choice_index:0,index:0,content});
  out+=ev(p+"items[].done",{choice_index:0,item,index:0});
  out+=ev(p+"completed",{index:0,choice});out+=ev(p+"done",{index:0,choice});
  out+=ev("session.response.done",{notices:[],session_id:sid,created_at:now+1,model,id:rid,choices:[choice],object:"session.response"});
  return {sid,body:out};
}
function reply(text,model,citations){const r=sse(text,model,citations);$done({response:{status:200,headers:{"Content-Type":"text/event-stream;charset=UTF-8","x-session-id":r.sid},body:r.body}});}
function fail(message,model){reply(message,model||"AI",[]);}
function buildRequest(a,messages){
  if(!a.key||!a.base||!a.model)throw new Error("请填写 API Key、API 地址和模型名称");
  const system=[a.prompt].concat(messages.filter(m=>m.role==="system").map(m=>m.content)).join("\n"),turns=messages.filter(m=>m.role!=="system");
  if(!turns.length)throw new Error("请求中没有可用的文本消息");
  if(a.provider==="gemini"){
    const body={systemInstruction:{parts:[{text:system}]},contents:turns.map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:a.max}};
    if(a.search)body.tools=[{google_search:{}}];
    return {url:a.base+"/v1beta/models/"+encodeURIComponent(a.model)+":generateContent",headers:{"Content-Type":"application/json","x-goog-api-key":a.key},body,kind:"gemini"};
  }
  if(a.provider==="anthropic"){
    return {url:a.base+"/v1/messages",headers:{"Content-Type":"application/json","x-api-key":a.key,"anthropic-version":"2023-06-01"},body:{model:a.model,max_tokens:a.max,system,messages:turns.map(m=>({role:m.role,content:m.content}))},kind:"anthropic"};
  }
  if(a.provider==="openai"||a.provider==="openai_compatible"){
    const base=/\/v1$/i.test(a.base)?a.base:a.base+"/v1";
    return {url:base+"/chat/completions",headers:{"Content-Type":"application/json",Authorization:"Bearer "+a.key},body:{model:a.model,messages:[{role:"system",content:system}].concat(turns.map(m=>({role:m.role,content:m.content}))),max_tokens:a.max,stream:false},kind:"openai"};
  }
  throw new Error("不支持的服务商："+a.provider);
}
function extract(j,kind){
  if(kind==="gemini"){const c=(j.candidates||[])[0]||{};return {text:((c.content&&c.content.parts)||[]).filter(p=>p.text&&!p.thought).map(p=>p.text).join(""),citations:(((c.groundingMetadata||{}).groundingChunks)||[]).map(x=>x.web).filter(x=>x&&x.uri).map(x=>({url:x.uri,title:x.title}))};}
  if(kind==="anthropic")return {text:(j.content||[]).filter(x=>x.type==="text").map(x=>x.text||"").join(""),citations:[]};
  return {text:j.choices&&j.choices[0]&&j.choices[0].message?j.choices[0].message.content:"",citations:[]};
}
(function main(){
  if(!$request||!/\/v1\/sessions\/responses/.test($request.url))return $done({});
  const a=getArgs(),label=a.model||"AI";
  if($request.method!=="POST")return fail("仅支持 POST 请求。",label);
  let body;try{body=JSON.parse($request.body);}catch(_){return fail("无法解析 Siri 请求，未向 AI 服务发送数据。",label);}
  if(!body||!Array.isArray(body.input))return fail("Siri 请求结构不受支持，未向 AI 服务发送数据。",label);
  const parsed=parse(body);
  if(parsed.unsupported)return fail("当前版本仅支持文本输入；图片及其他多模态内容尚未接入。",label);
  let req;try{req=buildRequest(a,parsed.messages);}catch(e){return fail(e.message,label);}
  let retried=false;
  function send(){
    console.log(TAG+" provider="+a.provider+" model="+a.model+"; using Loon configured policy");
    $httpClient.post({url:req.url,headers:req.headers,body:JSON.stringify(req.body),timeout:60000},(err,resp,data)=>{
      if(err)return fail("连接 AI 服务失败，请检查 API 地址及 Loon 当前网络规则。",label);
      const status=resp&&resp.status;let json;try{json=JSON.parse(data);}catch(_){return fail("AI 服务返回了无法解析的内容（HTTP "+status+"）。",label);}
      if((status===429||status>=500)&&!retried){retried=true;return send();}
      if(status<200||status>=300||json.error){const msg=json.error&&(json.error.message||json.error.type)||json.message||("HTTP "+status);console.log(TAG+" API error "+status+": "+String(msg).slice(0,180));return fail("AI 服务请求失败（"+status+"）："+String(msg).slice(0,140),label);}
      const result=extract(json,req.kind),output=clean(result.text);
      if(!output)return fail("AI 服务没有返回可读取的文本。",label);
      reply(output,label,result.citations);
    });
  }
  send();
})();
