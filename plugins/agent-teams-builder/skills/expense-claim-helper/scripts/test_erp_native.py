"""Offline behavior tests: these never connect to ERP or send input."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from erp_native import ERP, Window, Stop, create_claim, validate_request, verify_header, ocr_matches


REQUEST={
    'request_id':'test-claim-0001','company':'測試公司','document_type':'I502',
    'document_date':'2026-09-10','claim_date':'2026-09-10','applicant':'A0001',
    'department':'D001','counterparty':'A0001','bank_code':'001','bank_account':'000123',
    'payment_date':'2026-09-30','note':'離線測試','receipt_count':1,
    'payment_condition':'','cash_date':'','factory':'1','currency':'NTD','rate':'1',
    'detail':{'expense_code':'2011','summary':'離線測試','amount':1235,'voucher':'receipt','project':'ZZ','receipt_number':''},
}


class FakeERP:
    def __init__(self, fail_save=False):
        self.fills=0; self.saves=0; self.queries=0; self.detail_checks=0; self.fail_save=fail_save
        self.values={k:v for k,v in REQUEST.items() if k!='detail'}
        self.values.update(document_number='90000000001',payable='1,235',tax='0',total='1,235',status='瀏覽')
        self.n=SimpleNamespace(wait=self.wait,text=lambda _:'90000000001')
    def wait(self, check, *args, **kwargs):
        if self.fail_save: raise Stop('Simulated ambiguous save result')
        assert check()
    def fill(self, request): self.fills+=1; return self.values
    def read(self): return self.values
    def guard(self): pass
    def status(self): return '瀏覽'
    def field(self, _): return SimpleNamespace(hwnd=1)
    def ribbon(self, action):
        assert action=='save'; self.saves+=1
    def query(self, *_): self.queries+=1; return self.values
    def verify_detail(self, _): self.detail_checks+=1
    def verify_draft_detail(self, _): self.detail_checks+=1; return {'checked':True}
    def collect_review_evidence(self, request, number, folder):
        assert self.queries==1 and number==self.values['document_number']
        return {'saved_header':self.values,'images':['header.png','details.png']}


class BehaviorTests(unittest.TestCase):
    def test_no_implicit_defaults_and_unknown_fields(self):
        for field in ('payment_condition','cash_date','factory','currency','rate'):
            for mode in ('missing','null'):
                request=copy.deepcopy(REQUEST)
                if mode=='missing':request.pop(field)
                else:request[field]=None
                with self.assertRaises(Stop):validate_request(request)
        request=copy.deepcopy(REQUEST);request['payment_dat']='2026-09-30'
        with self.assertRaises(Stop):validate_request(request)
        request=copy.deepcopy(REQUEST);request['receipt_count']=True
        with self.assertRaises(Stop):validate_request(request)
        request=copy.deepcopy(REQUEST);request['detail']['summary']='  '
        with self.assertRaises(Stop):validate_request(request)

    def test_leading_zero_account_retained_and_numeric_rejected(self):
        self.assertEqual(validate_request(copy.deepcopy(REQUEST))['bank_account'],'000123')
        broken=copy.deepcopy(REQUEST); broken['bank_code']=1
        with self.assertRaises(Stop): validate_request(broken)

    def test_invoice_does_not_use_receipt_recipe(self):
        broken=copy.deepcopy(REQUEST); broken['detail']['voucher']='invoice'
        with self.assertRaises(Stop): validate_request(broken)

    def test_mismatched_account_and_amount_block_save(self):
        erp=FakeERP(); erp.values['bank_account']='000124'
        with self.assertRaises(Stop): verify_header(REQUEST,erp.values)
        erp=FakeERP(); erp.values['payable']='-1,235'
        with self.assertRaises(Stop): verify_header(REQUEST,erp.values)
        erp=FakeERP(); erp.values['bank_code']='1'
        with self.assertRaises(Stop): verify_header(REQUEST,erp.values)
        erp=FakeERP(); erp.values['payable']='1,236'
        with self.assertRaises(Stop): verify_header(REQUEST,erp.values)

    def test_fill_mode_never_saves(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP(); result=create_claim(erp,REQUEST,temp,False)
            self.assertEqual(result['stage'],'prepared'); self.assertEqual(erp.saves,0)

    def test_save_requires_query_and_detail_verification(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP(); result=create_claim(erp,REQUEST,temp,True)
            self.assertEqual((erp.fills,erp.saves,erp.queries,erp.detail_checks),(1,1,1,1))
            self.assertEqual(result['stage'],'verified')

    def test_ambiguous_save_cannot_repeat_same_request(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP(fail_save=True)
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,True)
            state=json.loads((Path(temp)/(REQUEST['request_id']+'.json')).read_text(encoding='utf-8'))
            self.assertEqual(state['stage'],'save_attempted')
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,True)
            self.assertEqual((erp.fills,erp.saves),(1,1))

    def test_one_run_stops_at_model_review_after_exact_query(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP(); result=create_claim(erp,REQUEST,temp,True,review_at_end=True)
            self.assertEqual((erp.fills,erp.saves,erp.queries,erp.detail_checks),(1,1,1,1))
            self.assertEqual(result['stage'],'awaiting_model_review')
            self.assertTrue(result['saved']); self.assertEqual(len(result['images']),2)
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,True,review_at_end=True)
            self.assertEqual(erp.saves,1)

    def test_evidence_failure_preserves_saved_state_without_second_save(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP()
            def fail(*args): raise Stop('Unrecognized evidence headings')
            erp.collect_review_evidence=fail
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,True,review_at_end=True)
            state=json.loads((Path(temp)/(REQUEST['request_id']+'.json')).read_text(encoding='utf-8'))
            self.assertEqual(state['stage'],'saved_header_verified')
            self.assertEqual(state['document_number'],'90000000001')
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,True,review_at_end=True)
            self.assertEqual(erp.saves,1)

    def test_draft_mismatch_prevents_save_in_one_run(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP()
            def fail(*args): raise Stop('Wrong project')
            erp.verify_draft_detail=fail
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,True,review_at_end=True)
            self.assertEqual(erp.saves,0)

    def test_review_mode_requires_save_before_creating_journal_or_draft(self):
        with tempfile.TemporaryDirectory() as temp:
            erp=FakeERP()
            with self.assertRaises(Stop): create_claim(erp,REQUEST,temp,False,review_at_end=True)
            self.assertEqual(erp.fills,0); self.assertEqual(list(Path(temp).iterdir()),[])

    def test_delphi_shared_application_owner_and_reused_dialog(self):
        main=Window(1,100,'TfrmPCMI10','PCMI10',(0,0,100,100),0,0,False)
        hidden=Window(2,100,'TApplication','',(0,0,0,0),0,0,False)
        query=Window(3,100,'TQBEForm','DSForm',(10,10,90,90),2,2,True)
        unrelated=Window(4,200,'TQBEForm','DSForm',(0,0,100,100),2,2,True)
        erp=ERP.__new__(ERP); erp.main=main
        windows=[main,query,unrelated]; byid={w.hwnd:w for w in [*windows,hidden]}
        erp.n=SimpleNamespace(windows=lambda:windows,info=lambda h:byid[h])
        self.assertEqual([w.hwnd for w in erp.modal_windows()],[3])
        windows.remove(query); self.assertEqual(erp.modal_windows(),[])
        windows.append(query); self.assertEqual([w.hwnd for w in erp.modal_windows()],[3])
        lookup=Window(5,100,'TfrmF2Window','DSForm',(0,0,100,100),0,0,True)
        windows.append(lookup); byid[5]=lookup
        erp.n.u=SimpleNamespace(IsWindowEnabled=lambda _:False)
        self.assertEqual({w.hwnd for w in erp.modal_windows()},{3,5})

    def test_unknown_dialog_does_not_get_silently_accepted(self):
        erp=ERP.__new__(ERP)
        popup=Window(8,100,'TUnexpected','Error',(0,0,100,100),1,1,True)
        erp.modal_windows=lambda:[popup]
        erp.n=SimpleNamespace(wait=lambda check,*_:check())
        with self.assertRaises(Stop): erp.wait_modal('TQBEForm')

    def test_ocr_locates_whole_column_label_only(self):
        words=[{'text':x,'x':i*10,'y':0,'width':10,'height':10} for i,x in enumerate('原幣金額本幣金額')]
        data={'lines':[{'words':words}]}
        self.assertEqual(ocr_matches(data,'原幣金額'),[(0,0,40,10)])
        self.assertEqual(ocr_matches(data,'專案代號'),[])


if __name__=='__main__': unittest.main()
