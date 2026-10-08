"""Generate a local, offline input form. Download JSON; never dispatch desktop actions."""
import html
import json


def render_form(manifest,schema):
    title=html.escape(manifest['title']); status=html.escape(manifest['status'])
    payload=json.dumps(schema,ensure_ascii=False).replace('<','\\u003c')
    scope=html.escape('；'.join(str(v) for v in schema.get('fixed_behavior',{}).values()))
    return '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>'''+title+'''｜輸入資料</title><style>
body{font:16px system-ui,sans-serif;background:#f3f6fa;color:#182a3b;margin:0}main{max-width:960px;margin:32px auto;padding:32px;background:white;border-radius:18px}h1{font-size:28px}p{line-height:1.6;color:#526176}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}label{display:block;font-weight:600}input,select{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:8px;border:1px solid #bac8d5;border-radius:7px;font:inherit}small{display:block;margin-top:5px;color:#627489;font-weight:400}button{background:#15695c;color:white;border:0;border-radius:8px;padding:13px 22px;font:inherit;margin-top:28px;cursor:pointer}#errors{white-space:pre-line;color:#ab2534}code{background:#eef2f6;padding:2px 6px}
</style><main><h1>'''+title+'''</h1><p>執行標籤：<code>'''+html.escape(manifest['tags'][0])+'''</code>　狀態：'''+status+'''</p>
<p>先填齊所有欄位，再下載 JSON 給助理執行。此頁完全離線，不會操作 ERP。允許留空的欄位仍需選擇「確定留空」。日期須包含年份；代碼與帳號以文字保留前導零。</p><p>固定支援範圍：'''+scope+'''</p>
<form id="form"><div class="grid" id="fields"></div><div id="errors" role="alert"></div><button>檢查並下載輸入 JSON</button></form></main>
<script>
const schema='''+payload+''';const controls=new Map();
for(const f of schema.fields){const box=document.createElement('label');box.textContent=f.label+' *';let input=document.createElement(f.enum?'select':'input');
 if(f.enum){input.add(new Option('請選擇',''));for(const v of f.enum)input.add(new Option(v===''?'確定留空':String(v),v===''?'__EMPTY__':String(v)));}
 else{input.type=f.type==='date'?'date':(['number','integer'].includes(f.type)?'number':'text');if(f.type==='number')input.step='0.01';if(f.type==='integer')input.step='1';if(f.minimum!==undefined)input.min=f.minimum;if(f.exclusive_minimum!==undefined)input.min=f.exclusive_minimum+0.01;}
 input.required=true;box.append(input);let empty=null;if(f.allow_empty&&!f.enum){empty=document.createElement('input');empty.type='checkbox';empty.style.width='auto';const e=document.createElement('small');e.append(empty,document.createTextNode('確定留空'));box.append(e);empty.onchange=()=>{input.disabled=empty.checked;input.required=!empty.checked;};}
 const hint=document.createElement('small');hint.textContent=f.help||f.name;box.append(hint);document.querySelector('#fields').append(box);controls.set(f.name,{f,input,empty});}
function put(o,k,v){const ps=k.split('.');for(const p of ps.slice(0,-1))o=o[p]??=( {} );o[ps.at(-1)]=v;}
document.querySelector('#form').onsubmit=e=>{e.preventDefault();const data={},flat={},errors=[];for(const [key,{f,input,empty}]of controls){let v=empty?.checked?'':input.value==='__EMPTY__'?'':input.value;if(['number','integer'].includes(f.type))v=Number(v);if(f.pattern&&v!==''&&!(new RegExp('^(?:'+f.pattern+')$')).test(v))errors.push(f.label+'：'+(f.pattern_message||'格式不符'));put(data,key,v);flat[key]=v;}
 for(const r of schema.rules||[])if(r.kind==='date_order'&&flat[r.start]>flat[r.end])errors.push('結束日期不可早於開始日期');document.querySelector('#errors').textContent=errors.join('\\n');if(errors.length)return;
 const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='input.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
</script></html>'''
