"""Offline execution-boundary tests. Never connects to a desktop or ERP."""
import copy,json,sys,tempfile,unittest
from pathlib import Path
from dispatch import validate,resolve,execute,InputError,template

SCHEMA={'fields':[
 {'name':'applicant','label':'申請人','type':'string','required':True},
 {'name':'bank','label':'銀行','type':'string','pattern':r'\d{3}','required':True},
 {'name':'start','label':'開始','type':'date','required':True},
 {'name':'end','label':'結束','type':'date','required':True},
 {'name':'note','label':'備註','type':'string','allow_empty':True,'required':True},
 {'name':'detail.amount','label':'金額','type':'number','exclusive_minimum':0,'decimals':2,'required':True},
 {'name':'count','label':'張數','type':'integer','minimum':0,'required':True},
], 'rules':[{'kind':'date_order','start':'start','end':'end'}]}
VALID={'applicant':'TEST','bank':'003','start':'2026-09-01','end':'2026-09-30','note':'','detail':{'amount':1500},'count':0}


class GateTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.folder=self.root/'receipt-create'
  self.folder.mkdir();self.manifest={'id':'receipt-create','title':'create','tags':['Key收據','收據'],'intent_pattern':'(?:key|建立|新增)[^，,。；;]{0,40}收據','status':'ready','entrypoint':'run.py'}
  self.write(self.folder/'automation.json',self.manifest);self.write(self.folder/'input.schema.json',SCHEMA)
  (self.folder/'run.py').write_text("raise RuntimeError('Executor imported before input gate')",encoding='utf-8')
 def tearDown(self):self.temp.cleanup()
 def write(self,p,d):p.write_text(json.dumps(d,ensure_ascii=False),encoding='utf-8')
 def test_missing_all_fields_collected_without_import(self):
  r=execute(self.folder,{},self.root/'runs',None)
  self.assertEqual(len(r['errors']),7);self.assertFalse(r['ERP_touched']);self.assertFalse((self.root/'runs').exists())
 def test_each_missing_required_blocks_executor(self):
  for k in VALID:
   d=copy.deepcopy(VALID);d.pop(k)
   self.assertEqual(execute(self.folder,d,self.root/'runs','fixed-run')['stage'],'needs_input')
 def test_explicit_empty_not_missing_or_null(self):
  self.assertFalse(validate(SCHEMA,VALID))
  d=copy.deepcopy(VALID);d['note']=None;self.assertTrue(validate(SCHEMA,d))
  d.pop('note');self.assertTrue(validate(SCHEMA,d))
 def test_zero_retained_but_bool_rejected(self):
  for k in ('bank','count'):
   d=copy.deepcopy(VALID);d[k]=True;self.assertTrue(validate(SCHEMA,d))
  self.assertEqual(VALID['bank'],'003')
 def test_negative_nonfinite_and_excess_precision(self):
  for v in (-1,0,True,float('nan'),float('inf'),1.111):
   d=copy.deepcopy(VALID);d['detail']['amount']=v;self.assertTrue(validate(SCHEMA,d))
 def test_dates_require_year_and_valid_order(self):
  for start in ('09/01','2026-02-30','2026-10-01','2026-9-1'):
   d=copy.deepcopy(VALID);d['start']=start;self.assertTrue(validate(SCHEMA,d))
 def test_unknown_or_whitespace_not_silently_ignored(self):
  d=copy.deepcopy(VALID);d['amunt']=1500;self.assertTrue(validate(SCHEMA,d))
  d=copy.deepcopy(VALID);d['applicant']='  ';self.assertTrue(validate(SCHEMA,d))
  d=copy.deepcopy(VALID);d['unknown_empty_object']={};self.assertTrue(validate(SCHEMA,d))
 def test_unverified_workflow_blocked_even_with_complete_input(self):
  self.manifest['status']='needs_calibration';self.write(self.folder/'automation.json',self.manifest)
  r=execute(self.folder,VALID,self.root/'runs','fixed-run');self.assertEqual(r['stage'],'needs_calibration');self.assertFalse(r['ERP_touched'])
 def test_validated_payload_passed_without_mutation(self):
  calls=[]
  result=execute(self.folder,VALID,self.root/'runs','fixed-run',invoke=lambda d,r,i:calls.append((d,r,i)) or {'ok':True})
  self.assertTrue(result['ok']);self.assertEqual(len(calls),1);self.assertEqual(calls[0][0],VALID)
 def test_id_invalid_before_import(self):
  with self.assertRaises(InputError):execute(self.folder,VALID,self.root/'runs','../../bad')
 def test_exact_casefold_and_query_preference(self):
  q=self.root/'receipt-query';q.mkdir();self.write(q/'automation.json',{'id':'receipt-query','title':'query','tags':['查詢收據'],'intent_pattern':'查詢.*收據','status':'needs_calibration'})
  self.assertEqual(resolve(self.root,'Ｋｅｙ 收據')[1]['id'],'receipt-create')
  self.assertEqual(resolve(self.root,'查詢2026/09/01到2026/09/30的收據')[1]['id'],'receipt-query')
  with self.assertRaises(InputError):resolve(self.root,'Key收據並查詢收據')
  with self.assertRaises(InputError):resolve(self.root,'新增一筆收據並查詢2026/09/01到2026/09/30的收據')
  with self.assertRaises(InputError):resolve(self.root,'先建立一筆會議餐費收據，再查詢9月收據')
  self.assertEqual(resolve(self.root,'收據 金額1500 申請人A0101')[1]['id'],'receipt-create')
 def test_template_never_contains_sample_business_values(self):
  d=template(SCHEMA);self.assertIsNone(d['bank']);self.assertIsNone(d['detail']['amount']);self.assertIsNone(d['note'])
 def test_path_escape_rejected(self):
  self.manifest['entrypoint']='../external.py';self.write(self.folder/'automation.json',self.manifest)
  (self.root/'external.py').write_text('raise RuntimeError()',encoding='utf-8')
  with self.assertRaises(InputError):execute(self.folder,VALID,self.root/'runs','fixed-run')


if __name__=='__main__':unittest.main()
