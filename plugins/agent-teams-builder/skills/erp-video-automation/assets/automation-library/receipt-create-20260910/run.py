"""Adapter to verified PCMI10 engine; validates everything before ERP access."""
from pathlib import Path
import hashlib,importlib.util,json,os,sys


def skill_script(skill,filename,skills_root=None):
    """Find a bundled sibling skill or an explicitly configured local install."""
    if skills_root is not None:
        roots=[Path(skills_root).expanduser()]
    elif os.environ.get('ERP_SKILLS_ROOT'):
        # An explicit install is authoritative; never mix it with a fallback.
        roots=[Path(os.environ['ERP_SKILLS_ROOT']).expanduser()]
    else:
        roots=[]
        # Supports both the original bundle and skills/<skill>/assets/library/<flow>.
        for parent in Path(__file__).resolve().parents:
            if parent.name=='skills': roots.append(parent)
            roots.append(parent/'skills')
        if os.environ.get('CODEX_HOME'):
            roots.append(Path(os.environ['CODEX_HOME']).expanduser()/'skills')
        roots.append(Path.home()/'.codex/skills')
    checked=[]
    for root in roots:
        script=(root/skill/'scripts'/filename).resolve()
        if script in checked: continue
        checked.append(script)
        if script.is_file(): return script
    raise RuntimeError('Missing '+skill+' dependency ('+filename+'). Install both ERP skills together, '
                       'or set ERP_SKILLS_ROOT to their skills directory / CODEX_HOME to the Codex directory. '
                       'Checked: '+', '.join(map(str,checked)))


def load_skill(script):
    # Import the selected file, even if another installation was loaded earlier.
    name='_erp_receipt_'+script.stem+'_'+hashlib.sha256(str(script).encode()).hexdigest()[:12]
    spec=importlib.util.spec_from_file_location(name,script)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    try: spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name,None)
        raise
    return module


def run(data,runs,run_id):
    router_script=skill_script('erp-video-automation','dispatch.py')
    router=load_skill(router_script)
    errors=router.validate(router.read_json(Path(__file__).with_name('input.schema.json')),data)
    if errors:return {'ok':False,'stage':'needs_input','ERP_touched':False,'errors':errors}
    manifest=router.read_json(Path(__file__).with_name('automation.json'))
    if manifest.get('status')!='ready':return {'ok':False,'stage':'needs_calibration','ERP_touched':False,'reason':manifest.get('blocked_reason','Workflow has not been calibrated')}
    import re
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{5,79}',run_id or ''):raise ValueError('Fixed run_id required')
    # Keep the router and GUI executor from the same install/version.
    engine=load_skill(skill_script('expense-claim-helper','erp_native.py',router_script.parents[2]))
    request=json.loads(json.dumps(data));mode=request.pop('execution_mode');request['request_id']=run_id
    engine.validate_request(request)
    runs=Path(runs);runs.mkdir(parents=True,exist_ok=True)
    if (runs/(run_id+'.json')).exists():raise RuntimeError('Existing request journal; inspect original document, never recreate')
    # Keep the validated input for recovery, separate from generated receipts.
    input_path=runs/(run_id+'.input.json')
    if input_path.exists():
        if json.loads(input_path.read_text(encoding='utf-8'))!=request:raise RuntimeError('run_id already belongs to different input')
    else:
        with input_path.open('x',encoding='utf-8') as f:json.dump(request,f,ensure_ascii=False,indent=2)
    erp=engine.ERP(request['company']);lock=engine.DesktopLock(erp.main.pid)
    try:return engine.create_claim(erp,request,runs,mode=='save',review_at_end=mode=='save')
    finally:lock.close()


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--run-id',required=True)
    p.add_argument('--runs',type=Path,default=Path(__file__).parents[1]/'runs');a=p.parse_args()
    try:
        result=run(json.loads(a.input.read_text(encoding='utf-8-sig')),a.runs,a.run_id)
        print(json.dumps(result,ensure_ascii=False));raise SystemExit(2 if result.get('ok') is False else 0)
    except Exception as exc:
        print(json.dumps({'ok':False,'error':str(exc),'no_automatic_retry':True},ensure_ascii=False));raise SystemExit(2)
