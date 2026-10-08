"""Resume only confirmed failures and preserve partially configured VMs."""
from unittest.mock import Mock
import pytest
import requests
from .test_install_task_results import load, Response


def production():
    ns = load('create_prod_vms.py')
    ns['find_vm'] = Mock(return_value=None)
    ns['create_vm'] = Mock()
    return ns


@pytest.mark.parametrize('code', ['VMM-10011', 'RETRYABLE_ERROR', 'VMM-30604'])
def test_confirmed_retryable_failure_is_retried(code):
    ns = production()
    ns['create_vm'].side_effect = [(False, 'task FAILED: ' + code), (True, 'created')]
    assert ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')[0]
    assert ns['create_vm'].call_count == 2
    assert ns['find_vm'].call_count == 2


@pytest.mark.parametrize('message', ['task id did not finish; outcome unknown',
    'mutation response missing task reference; outcome unknown', 'task FAILED: permission denied',
    '503 response lost'])
def test_ambiguous_or_permanent_failure_never_resubmits(message):
    ns = production()
    ns['create_vm'].return_value = (False, message)
    assert not ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')[0]
    ns['create_vm'].assert_called_once()


def test_retry_limit_has_network_recovery_guidance():
    ns = production()
    ns['create_vm'].return_value = (False, 'task FAILED: VMM-30604')
    ok, message = ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')
    assert not ok and 'Keep Advanced' in message
    assert ns['create_vm'].call_count == 3


def test_inventory_failure_cannot_trigger_create():
    ns = production()
    ns['find_vm'].side_effect = requests.HTTPError('503')
    with pytest.raises(requests.HTTPError):
        ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')
    ns['create_vm'].assert_not_called()


def test_duplicate_names_are_not_silently_reused():
    ns = load('create_prod_vms.py')
    ns['_req_retry'] = Mock(return_value=Response({'data': [{'extId': 'a'}, {'extId': 'b'}]}))
    with pytest.raises(Exception, match='Multiple VMs'):
        ns['find_vm']('prd-mail')


@pytest.mark.parametrize('profile,powered', [('hpoc', True), ('other', False)])
def test_resume_completes_project_and_power_for_existing_vms(profile, powered):
    ns = production()
    ns['CLUSTER_PROFILE'] = profile
    ns['get_category_uuid'] = lambda: 'cat'
    ns['get_subnet_uuid'] = lambda _: 'net'
    ns['get_image_uuid'] = lambda: 'img'
    ns['find_vm'].return_value = {'extId': 'vm', 'cluster': {'extId': ns['CLUSTER_UUID']},
        'categories': [{'extId': 'cat'}], 'nics': [{'networkInfo': {'subnet': {'extId': 'net'}}}]}
    ns['assign_project_and_set_power'] = Mock(return_value=(True, 'configured'))
    assert ns['main']() == 0
    ns['create_vm'].assert_not_called()
    assert ns['assign_project_and_set_power'].call_count == 7
    assert all(c.args[1] is powered for c in ns['assign_project_and_set_power'].call_args_list)


def test_name_collision_with_unrelated_vm_stops_recovery():
    ns = production()
    ns['find_vm'].return_value = {'cluster': {'extId': 'other-cluster'}}
    with pytest.raises(Exception, match='another cluster'):
        ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')
    ns['create_vm'].assert_not_called()


def test_rate_limit_respects_retry_after_before_inventory_retry():
    ns = load('create_prod_vms.py')
    limited = Response({}, 429)
    limited.headers = {'Retry-After': '45'}
    ns['requests'].request = Mock(side_effect=[limited, Response({'data': []})])
    assert ns['find_vm']('prd-mail') is None
    ns['time'].sleep.assert_called_once_with(45)


def test_retry_does_not_create_duplicate_when_vm_appears_after_failure():
    ns = production()
    ns['find_vm'].side_effect = [None, {'extId': 'vm', 'cluster': {'extId': ns['CLUSTER_UUID']},
        'categories': [{'extId': 'cat'}], 'nics': [{'networkInfo': {'subnet': {'extId': 'net'}}}]}]
    ns['create_vm'].return_value = (False, 'task FAILED: VMM-10011')
    assert ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')[0]
    ns['create_vm'].assert_called_once()


@pytest.mark.parametrize('nic_key', ['networkInfo', 'nicNetworkInfo'])
def test_resume_requests_categories_and_accepts_both_nic_shapes(nic_key):
    ns = load('create_prod_vms.py')
    vm = {'extId': 'vm', 'cluster': {'extId': ns['CLUSTER_UUID']},
          'categories': [{'extId': 'cat'}], 'nics': [{nic_key: {'subnet': {'extId': 'net'}}}]}
    def inventory(method, url, **kwargs):
        assert method == 'GET'
        fields = kwargs['params']['$select'].split(',')
        return Response({'data': [{k: v for k, v in vm.items() if k in fields}]})
    ns['_req_retry'] = inventory
    ns['create_vm'] = Mock()
    assert ns['ensure_vm'](ns['VM_SPECS'][0], 'cat', 'net', 'img')[0]
    ns['create_vm'].assert_not_called()
