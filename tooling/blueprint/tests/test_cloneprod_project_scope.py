import ast
import json
import tarfile
import uuid
from pathlib import Path
from types import SimpleNamespace
import pytest

ROOT = Path(__file__).parents[1]
MEMBER = 'CloneProd/scripts/Service_Cloner_Action___create___Task_ClonetheEnvironment.py'


def functions(path=None):
    if path:
        source = path.read_text()
    else:
        with tarfile.open(ROOT / 'prereqs/CloneProd.tgz') as archive:
            source = archive.extractfile(MEMBER).read().decode()
    module = ast.parse(source)
    selected = ast.Module(body=[n for n in module.body if isinstance(n, ast.FunctionDef)], type_ignores=[])
    env = {'json': json, 'uuid': uuid, 'time': SimpleNamespace(sleep=lambda _: None)}
    exec(compile(selected, 'blueprint-functions', 'exec'), env)
    return env


class Response:
    headers = {'ETag': 'revision'}
    def __init__(self, body): self.body = body
    def json(self): return self.body
    def raise_for_status(self): pass


def test_clone_success_never_shares():
    e=functions();calls=[]
    e['waitOperation']=lambda response,label:calls.append(label)
    e['shareCloneSubnet']=lambda *args:pytest.fail('unexpected share')
    e['cloneWithProjectScope'](lambda: {},'vm','subnet')
    assert calls==['Clone VM']


def test_confirmed_subnet_rejection_shares_once_then_retries():
    e=functions();calls=[]
    def wait(response,label):
        calls.append(label)
        if label=='Clone VM': raise RuntimeError('VMM-31701 Subnet rejected')
    e['waitOperation']=wait;e['shareCloneSubnet']=lambda *args:calls.append(args)
    e['cloneWithProjectScope'](lambda: {},'vm','subnet')
    assert calls==['Clone VM',('vm','subnet'),'Clone VM retry']


@pytest.mark.parametrize('error',['VMM-31701 Category rejected','permission denied','unknown task result'])
def test_other_errors_do_not_share(error):
    e=functions()
    def wait(*args): raise RuntimeError(error)
    e['waitOperation']=wait;e['shareCloneSubnet']=lambda *args:pytest.fail('unexpected share')
    with pytest.raises(RuntimeError,match=error):e['cloneWithProjectScope'](lambda: {},'vm','subnet')


def test_failed_task_surfaces_its_reason():
    e=functions();e.update(prismCentralIp='pc',pcUsername='user',pcPassword='test')
    e['requests']=SimpleNamespace(get=lambda *a,**k:Response({'data':{'status':'FAILED','errorMessages':[{'code':'VMM-31701','message':'Subnet rejected'}]}}))
    with pytest.raises(RuntimeError,match='VMM-31701'):e['waitOperation']({'data':{'extId':'task'}},'Clone')


def test_missing_task_cannot_report_success():
    with pytest.raises(RuntimeError,match='no task'):functions()['waitOperation']({},'Clone')


def test_running_task_has_bounded_wait():
    e=functions();e.update(prismCentralIp='pc',pcUsername='user',pcPassword='test');calls=[]
    def get(*a,**k):calls.append(1);return Response({'data':{'status':'RUNNING'}})
    e['requests']=SimpleNamespace(get=get)
    with pytest.raises(RuntimeError,match='timed out'):e['waitOperation']({'data':{'extId':'task'}},'Clone',maxPolls=2)
    assert len(calls)==2


@pytest.mark.parametrize('state',['COMPLETE','ERROR'])
def test_production_directory_and_membership_result(state):
    e=functions(ROOT/'scripts/setup_production_project.py');captured=[]
    def put(*a,**k):captured.append(json.loads(k['data']));return Response({})
    e.update(BASE='https://pc',AUTH=('user','test'),HEADERS={},PROJECT_NAME='production',PROJECT_ADMIN='thebadguy',SECONDARY_SUBNET_NAME='secondary')
    e['_SESS']=SimpleNamespace(put=put,get=lambda *a,**k:Response({'status':{'state':state,'resources':{'user_reference_list':[{'uuid':'user'}]},'message_list':[{'message':'rejected'}]}}))
    args=('project','account','primary','secondary','cluster','user','role','directory',1)
    if state=='ERROR':
        with pytest.raises(Exception,match='membership failed'):e['add_user_as_project_admin'](*args)
    else:assert e['add_user_as_project_admin'](*args)
    assert captured[0]['spec']['project_detail']['resources']['directory_reference_list']==[{'kind':'directory_service','uuid':'directory'}]
