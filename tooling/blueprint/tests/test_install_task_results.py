"""Accepted mutations must not let a broken deployment reach the game container."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

SCRIPTS = Path(__file__).parent.parent / 'scripts'


class Response:
    def __init__(self, body, status_code=200):
        self.body = body
        self.status_code = status_code
        self.text = str(body)

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


def load(name):
    path = SCRIPTS / name
    ns = {}
    exec(compile(path.read_text().rsplit('\nsys.exit(main())', 1)[0], str(path), 'exec'), ns)
    ns['requests'] = SimpleNamespace(get=Mock(), post=Mock(), put=Mock(),
                                     RequestException=requests.RequestException)
    ns['time'] = SimpleNamespace(sleep=Mock())
    ns['TASK_POLLS'] = 3
    return ns


@pytest.fixture(params=['setup_subnets.py', 'create_prod_vms.py'])
def script(request):
    return load(request.param)


ACCEPTED = Response({'data': {'extId': 'task-id'}}, 202)


def task(status, **kw):
    return Response({'data': {'status': status, **kw}})


def test_waits_for_terminal_success(script):
    script['requests'].get.side_effect = [task('QUEUED'), task('RUNNING'), task('SUCCEEDED')]
    assert script['wait_for_task'](ACCEPTED)[0]
    assert script['requests'].get.call_count == 3


@pytest.mark.parametrize('status', ['FAILED', 'CANCELED', 'CANCELLED'])
def test_failed_task_preserves_nutanix_error(script, status):
    script['requests'].get.return_value = task(status, legacyErrorMessage='migration failed',
        errorMessages=[{'message': 'AHV 11.2 required'}])
    ok, message = script['wait_for_task'](ACCEPTED)
    assert not ok
    assert status in message and 'migration failed' in message and 'AHV 11.2 required' in message


def test_read_errors_retry_without_resubmitting_mutation(script):
    script['requests'].get.side_effect = [requests.ReadTimeout('transient'), Response({}, 503), task('SUCCEEDED')]
    assert script['wait_for_task'](ACCEPTED)[0]
    script['requests'].post.assert_not_called()


def test_unknown_outcome_is_not_success(script):
    script['requests'].get.return_value = task('RUNNING')
    ok, message = script['wait_for_task'](ACCEPTED)
    assert not ok and 'outcome unknown' in message
    assert script['requests'].get.call_count == 3


def test_missing_reference_is_not_success(script):
    assert not script['wait_for_task'](Response({}, 202))[0]
    script['requests'].get.assert_not_called()


def test_v3_assignment_failure_is_reported(script):
    script['requests'].get.return_value = Response({'status': 'FAILED', 'error_detail': 'project rejected'})
    ok, message = script['wait_for_task'](
        Response({'status': {'execution_context': {'task_uuid': 'v3-task'}}}, 202), v3=True)
    assert not ok and 'project rejected' in message
    assert '/api/nutanix/v3/tasks/v3-task' in script['requests'].get.call_args.args[0]


@pytest.mark.parametrize('operation', ['migration', 'creation', 'rename'])
def test_subnet_mutation_failure_is_not_logged_as_success(operation, capsys):
    ns = load('setup_subnets.py')
    ns['get_subnet_by_id'] = lambda _: ({'data': {'name': 'aux-1'}}, 'etag')
    ns['requests'].post.return_value = ACCEPTED
    ns['requests'].put.return_value = ACCEPTED
    ns['requests'].get.return_value = task('FAILED', errorMessages=[{'message': 'not supported'}])
    if operation == 'migration':
        result = ns['migrate_secondary_to_advanced']({'extId': 'secondary'})
    elif operation == 'creation':
        result = ns['create_test_network']([])
    else:
        result = ns['rename_aux1_to_secondary']([{'name': 'aux-1', 'extId': 'aux'}])
    assert not result
    assert '[ok]' not in capsys.readouterr().out


def test_successful_migration_requires_visible_advanced_subnet():
    ns = load('setup_subnets.py')
    ns['get_subnet_by_id'] = lambda _: ({}, 'etag')
    ns['requests'].post.return_value = ACCEPTED
    ns['requests'].get.return_value = task('SUCCEEDED')
    ns['list_subnets'] = Mock(return_value=[{'extId': 'secondary', 'isAdvancedNetworking': False}])
    assert not ns['migrate_secondary_to_advanced']({'extId': 'secondary'})
    ns['list_subnets'].side_effect = [[{'extId': 'secondary', 'isAdvancedNetworking': False}],
                                     [{'extId': 'secondary', 'isAdvancedNetworking': True}]]
    assert ns['migrate_secondary_to_advanced']({'extId': 'secondary'})


def test_failed_migration_stops_network_install():
    ns = load('setup_subnets.py')
    ns['list_subnets'] = lambda: [{'name': 'secondary'}]
    ns['rename_aux1_to_secondary'] = lambda _: {'name': 'secondary'}
    ns['migrate_secondary_to_advanced'] = lambda _: False
    ns['create_test_network'] = Mock()
    assert ns['main']() == 1
    ns['create_test_network'].assert_not_called()


def test_create_vm_returns_async_failure():
    ns = load('create_prod_vms.py')
    ns['requests'].post.return_value = ACCEPTED
    ns['requests'].get.return_value = task('FAILED', errorMessages=[{'message': 'subnet not found'}])
    ok, message = ns['create_vm'](ns['VM_SPECS'][0], 'cat', 'subnet', 'image')
    assert not ok and 'subnet not found' in message
    assert ns['requests'].post.call_count == 1


@pytest.mark.parametrize('failure', ['create', 'assign'])
def test_vm_failure_stops_install_before_next_vm(failure):
    ns = load('create_prod_vms.py')
    ns['get_category_uuid'] = lambda: 'cat'
    ns['get_subnet_uuid'] = lambda _: 'subnet'
    ns['get_image_uuid'] = lambda: 'image'
    ns['vm_exists'] = lambda _: False
    ns['create_vm'] = Mock(return_value=(failure != 'create', 'create verdict'))
    ns['assign_project_and_set_power'] = Mock(return_value=(False, 'assignment failed'))
    assert ns['main']() == 1
    assert ns['create_vm'].call_count == 1
    if failure == 'create':
        ns['assign_project_and_set_power'].assert_not_called()


def test_assignment_waits_for_its_task():
    ns = load('create_prod_vms.py')
    ns['requests'].get.side_effect = [Response({'data': [{'extId': 'vm'}]}),
        Response({'metadata': {}, 'spec': {'resources': {}}}),
        Response({'status': 'FAILED', 'error_detail': 'assignment denied'})]
    ns['requests'].put.return_value = Response({'status': {'execution_context': {'task_uuid': 'assign'}}}, 202)
    ok, message = ns['assign_project_and_set_power']('vm', False)
    assert not ok and 'assignment denied' in message
