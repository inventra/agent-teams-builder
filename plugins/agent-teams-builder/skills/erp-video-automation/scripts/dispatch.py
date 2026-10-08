"""Local automation catalogue and input gate. No desktop imports before validation."""
from __future__ import annotations
import argparse
from datetime import date
from decimal import Decimal, InvalidOperation
import importlib.util
import json
from pathlib import Path
import re
import sys
import unicodedata


class InputError(ValueError): pass


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def normal(text): return re.sub(r'\s+', '', unicodedata.normalize('NFKC',text)).casefold()


def catalogue(library):
    result=[]
    for p in sorted(Path(library).glob('*/automation.json')):
        m=read_json(p)
        if m.get('id')!=p.parent.name: raise InputError('Automation id/folder mismatch: '+str(p))
        result.append((p.parent,m))
    return result


def resolve(library,text):
    text=normal(text)
    if len(text)>2000: raise InputError('Routing text too long')
    entries=catalogue(library)
    exact=[(p,m) for p,m in entries if text in [normal(t) for t in [m['id'],*m['tags']]]]
    matches=exact or [(p,m) for p,m in entries if m.get('intent_pattern') and re.search(m['intent_pattern'],text)]
    if not matches:
        # A bare label followed by field data still identifies a workflow.
        # Action patterns above take priority, so a query never falls back to create.
        matches=[(p,m) for p,m in entries if any(text.startswith(normal(tag)) for tag in m['tags'])]
    if len(matches)!=1:
        raise InputError('無法唯一判斷自動化，請指定標籤；候選：'+', '.join(m['id'] for _,m in matches))
    return matches[0]


def flatten(data,prefix=''):
    result={}
    for k,v in data.items():
        key=prefix+k
        if isinstance(v,dict) and v: result.update(flatten(v,key+'.'))
        else: result[key]=v
    return result


def put(data,key,value):
    parts=key.split('.')
    for part in parts[:-1]: data=data.setdefault(part,{})
    data[parts[-1]]=value


def validate(schema,data):
    if not isinstance(data,dict): return [{'field':'$','label':'輸入','error':'必須是 JSON 物件'}]
    errors=[]; values=flatten(data); fields=schema['fields']; known={f['name'] for f in fields}
    for key in values.keys()-known: errors.append({'field':key,'label':key,'error':'未知欄位，請檢查拼字'})
    for f in fields:
        key=f['name']; label=f['label']; value=values.get(key)
        def fail(message): errors.append({'field':key,'label':label,'error':message})
        if key not in values or value is None:
            if f.get('required',True): fail('尚未填寫；允許空白的欄位也須明確指定空字串')
            continue
        kind=f['type']
        if kind in ('string','date'):
            if not isinstance(value,str): fail('請使用文字，代碼及帳號須保留前導零'); continue
            if value=='':
                if not f.get('allow_empty',False): fail('不可空白')
                continue
            if not value.strip() or value!=value.strip(): fail('不可只有空白或包含首尾空白'); continue
            if kind=='date':
                try:
                    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value): raise ValueError()
                    date.fromisoformat(value)
                except ValueError: fail('日期須包含年份，格式 YYYY-MM-DD 且為有效日期')
            if f.get('pattern') and not re.fullmatch(f['pattern'],value): fail(f.get('pattern_message','格式不符'))
        elif kind in ('integer','number'):
            if isinstance(value,bool) or not isinstance(value,(int,float)) or (kind=='integer' and not isinstance(value,int)):
                fail('請填整數' if kind=='integer' else '請填數值'); continue
            try: n=Decimal(str(value))
            except InvalidOperation: fail('無效數值'); continue
            if not n.is_finite(): fail('數值須為有限數'); continue
            if 'minimum' in f and n<Decimal(str(f['minimum'])): fail('低於最小值 '+str(f['minimum']))
            if 'exclusive_minimum' in f and n<=Decimal(str(f['exclusive_minimum'])): fail('須大於 '+str(f['exclusive_minimum']))
            if 'decimals' in f and n.as_tuple().exponent < -f['decimals']: fail('小數位數過多')
        else: raise InputError('Unsupported schema type: '+kind)
        if 'enum' in f and value not in f['enum']: fail('允許值：'+', '.join(map(str,f['enum'])))
    for rule in schema.get('rules',[]):
        if rule['kind']!='date_order': raise InputError('Unsupported cross-field rule')
        start,end=rule['start'],rule['end']
        if values.get(start) and values.get(end) and not any(e['field'] in (start,end) for e in errors):
            if values[start]>values[end]: errors.append({'field':end,'label':end,'error':'結束日期不可早於開始日期'})
    return errors


def template(schema):
    result={}
    # No business values are silently pre-filled, including nullable/blank fields.
    for f in schema['fields']: put(result,f['name'],None)
    return result


def execute(folder,data,runs,run_id,invoke=None):
    folder=Path(folder); m=read_json(folder/'automation.json'); schema=read_json(folder/'input.schema.json')
    errors=validate(schema,data)
    if errors: return {'ok':False,'stage':'needs_input','ERP_touched':False,'errors':errors}
    if m.get('status')!='ready':
        return {'ok':False,'stage':'needs_calibration','ERP_touched':False,'reason':m.get('blocked_reason','流程未驗證')}
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{5,79}',run_id or ''): raise InputError('請提供固定 --run-id（6–80 個英數字、底線或連字號），重试勿更換')
    entry=(folder/m['entrypoint']).resolve()
    if not entry.is_relative_to(folder.resolve()) or not entry.is_file(): raise InputError('Invalid local entrypoint')
    # Missing input/status checks happen BEFORE importing any executor or touching ERP.
    if invoke is not None: return invoke(data,Path(runs),run_id)
    spec=importlib.util.spec_from_file_location('erp_workflow_'+m['id'].replace('-','_'),entry)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.run(data,Path(runs),run_id)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('command',choices=['list','resolve','schema','validate','run','form','init-contract'])
    p.add_argument('--library',type=Path,required=True)
    p.add_argument('--key');p.add_argument('--input',type=Path);p.add_argument('--run-id')
    p.add_argument('--runs',type=Path);p.add_argument('--out',type=Path)
    a=p.parse_args()
    try:
        if a.command=='list':
            result={'automations':[{'id':m['id'],'title':m['title'],'tags':m['tags'],'status':m['status'],'folder':str(f.resolve())} for f,m in catalogue(a.library)]}
        else:
            if not a.key: raise InputError('--key required')
            folder,m=resolve(a.library,a.key)
            if a.command=='resolve': result={'id':m['id'],'status':m['status'],'folder':str(folder.resolve())}
            elif a.command=='schema': result=read_json(folder/'input.schema.json')
            elif a.command=='init-contract':
                target=folder/'input.template.json'
                with target.open('x',encoding='utf-8') as f:json.dump(template(read_json(folder/'input.schema.json')),f,ensure_ascii=False,indent=2)
                result={'path':str(target.resolve())}
            elif a.command=='form':
                from input_form import render_form
                target=a.out or folder/'input.html'
                target.write_text(render_form(m,read_json(folder/'input.schema.json')),encoding='utf-8')
                result={'path':str(target.resolve()),'ERP_touched':False}
            else:
                if not a.input: raise InputError('--input required')
                data=read_json(a.input)
                if a.command=='validate':
                    errors=validate(read_json(folder/'input.schema.json'),data)
                    result={'ok':not errors,'stage':'needs_input' if errors else 'input_valid','ERP_touched':False,'errors':errors,'execution_status':m['status']}
                else: result=execute(folder,data,a.runs or a.library/'runs',a.run_id)
        print(json.dumps(result,ensure_ascii=False,default=str))
        return 2 if result.get('ok') is False else 0
    except Exception as exc:
        print(json.dumps({'ok':False,'error':str(exc),'no_automatic_retry':True},ensure_ascii=False));return 2


if __name__=='__main__': raise SystemExit(main())
