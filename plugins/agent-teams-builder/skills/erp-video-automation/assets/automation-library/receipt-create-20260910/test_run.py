"""Offline portability and gate tests. Never loads the real GUI executor."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent


def adapter_at(path):
    spec=importlib.util.spec_from_file_location('receipt_adapter_test',path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCE=adapter_at(HERE/'run.py')
ROUTER=SOURCE.skill_script('erp-video-automation','dispatch.py')


class PortabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.env=patch.dict(os.environ,{},clear=True)
        self.home=patch.object(Path,'home',return_value=self.root/'empty-home')
        self.env.start();self.home.start()

    def tearDown(self):
        self.home.stop();self.env.stop();self.temp.cleanup()

    def flow(self,folder):
        folder.mkdir(parents=True)
        for name in ('run.py','input.schema.json','input.template.json','automation.json'):
            shutil.copyfile(HERE/name,folder/name)
        return adapter_at(folder/'run.py')

    def router(self,skills):
        target=skills/'erp-video-automation/scripts/dispatch.py'
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROUTER,target)
        return target.resolve()

    def forbidden_engine(self,skills):
        target=skills/'expense-claim-helper/scripts/erp_native.py'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text("raise AssertionError('GUI executor imported before gate')\n",encoding='utf-8')
        return target.resolve()

    def payload(self):
        return {'execution_mode':'prepare','company':'測試公司','document_type':'I502',
                'document_date':'2026-09-10','claim_date':'2026-09-10','applicant':'A0001',
                'counterparty':'A0001','department':'D001','factory':'1','currency':'NTD','rate':'1',
                'bank_code':'001','bank_account':'000123','payment_date':'2026-09-30',
                'payment_condition':'','cash_date':'','note':'離線測試','receipt_count':1,
                'detail':{'expense_code':'TEST','summary':'離線測試','amount':1235,
                          'voucher':'receipt','receipt_number':'','project':'TEST'}}

    def test_actual_blank_template_uses_bundle_without_home_installation(self):
        skills=self.root/'bundle/skills';self.router(skills);self.forbidden_engine(skills)
        flow=self.flow(self.root/'bundle/自動化資料庫/receipt-create-20260910')
        blank=json.loads((HERE/'input.template.json').read_text(encoding='utf-8-sig'))
        result=flow.run(blank,self.root/'runs',None)
        self.assertEqual(result['stage'],'needs_input')
        self.assertEqual(len(result['errors']),len(json.loads((HERE/'input.schema.json').read_text(encoding='utf-8-sig'))['fields']))
        self.assertFalse(result['ERP_touched']);self.assertFalse((self.root/'runs').exists())

    def test_relocated_plugin_finds_both_sibling_skills(self):
        skills=self.root/'plugin/skills'
        router=self.router(skills);engine=self.forbidden_engine(skills)
        flow=self.flow(skills/'erp-video-automation/assets/automation-library/receipt-create-20260910')
        self.assertEqual(flow.skill_script('erp-video-automation','dispatch.py'),router)
        self.assertEqual(flow.skill_script('expense-claim-helper','erp_native.py'),engine)

    def test_explicit_skills_root_overrides_bundled_copy(self):
        bundled=self.root/'bundle/skills';self.router(bundled)
        explicit=self.root/'custom-skills';router=self.router(explicit)
        flow=self.flow(self.root/'bundle/自動化資料庫/receipt-create-20260910')
        with patch.dict(os.environ,{'ERP_SKILLS_ROOT':str(explicit)}):
            self.assertEqual(flow.skill_script('erp-video-automation','dispatch.py'),router)
            router.unlink()
            with self.assertRaisesRegex(RuntimeError,'Missing erp-video-automation dependency'):
                flow.skill_script('erp-video-automation','dispatch.py')

    def test_custom_codex_home_and_default_home_fallback(self):
        flow=self.flow(self.root/'separate-library/receipt-create-20260910')
        custom=self.root/'configured-codex';router=self.router(custom/'skills')
        with patch.dict(os.environ,{'CODEX_HOME':str(custom)}):
            self.assertEqual(flow.skill_script('erp-video-automation','dispatch.py'),router)
        default=self.router(Path.home()/'.codex/skills')
        self.assertEqual(flow.skill_script('erp-video-automation','dispatch.py'),default)

    def test_missing_executor_has_clear_error_and_creates_no_runs(self):
        skills=self.root/'bundle/skills';self.router(skills)
        flow=self.flow(self.root/'bundle/自動化資料庫/receipt-create-20260910')
        with self.assertRaisesRegex(RuntimeError,r'Missing expense-claim-helper dependency.*ERP_SKILLS_ROOT'):
            flow.run(self.payload(),self.root/'runs','fixed-request-01')
        self.assertFalse((self.root/'runs').exists())

    def test_selected_router_root_refuses_valid_fallback_executor(self):
        selected=self.root/'bundle/skills';self.router(selected)
        flow=self.flow(self.root/'bundle/自動化資料庫/receipt-create-20260910')
        fallback=Path.home()/'.codex/skills';self.router(fallback)
        executor=fallback/'expense-claim-helper/scripts/erp_native.py'
        executor.parent.mkdir(parents=True)
        executor.write_text('FALLBACK_VERSION = 2\n',encoding='utf-8')
        blank=json.loads((HERE/'input.template.json').read_text(encoding='utf-8-sig'))
        for override in ({},{'ERP_SKILLS_ROOT':str(selected)}):
            with self.subTest(override=override),patch.dict(os.environ,override):
                self.assertEqual(flow.run(blank,self.root/'runs',None)['stage'],'needs_input')
                with self.assertRaisesRegex(RuntimeError,'Missing expense-claim-helper dependency') as error:
                    flow.run(self.payload(),self.root/'runs','fixed-request-01')
                self.assertIn(str(selected/'expense-claim-helper/scripts/erp_native.py'),str(error.exception))
                self.assertNotIn(str(executor),str(error.exception))
                self.assertFalse((self.root/'runs').exists())

    def test_unready_status_and_invalid_id_do_not_import_executor(self):
        skills=self.root/'bundle/skills';self.router(skills);self.forbidden_engine(skills)
        folder=self.root/'bundle/自動化資料庫/receipt-create-20260910';flow=self.flow(folder)
        manifest=json.loads((folder/'automation.json').read_text(encoding='utf-8-sig'))
        manifest['status']='needs_calibration'
        (folder/'automation.json').write_text(json.dumps(manifest),encoding='utf-8')
        result=flow.run(self.payload(),self.root/'runs','fixed-request-01')
        self.assertEqual(result['stage'],'needs_calibration');self.assertFalse(result['ERP_touched'])
        manifest['status']='ready';(folder/'automation.json').write_text(json.dumps(manifest),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'Fixed run_id required'):
            flow.run(self.payload(),self.root/'runs','../invalid')
        self.assertFalse((self.root/'runs').exists())


if __name__=='__main__':unittest.main()
