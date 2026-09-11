"""Final verification must not turn best-effort activation into a readiness claim."""
from unittest.mock import Mock
import pytest
import requests
from .test_install_task_results import load, Response


def verifier():
    ns = load('verify_state.py')
    ns['CLUSTER_PROFILE'] = 'hpoc'
    ns['CLUSTER_UUID'] = 'cluster'
    ns['fetch'] = Mock(side_effect=[[{'extId': 'cluster', 'name': 'test'}],
        [{'nodeStatus': 'NORMAL', 'maintenanceState': 'normal', 'hostName': 'host'}]])
    ns['discover_unconfigured_nodes'] = Mock(return_value=([], None))
    return ns


@pytest.mark.parametrize('enabled,state', [(False, 'RUNNING'), (False, 'COMPLETED'), (True, 'ERROR')])
def test_incomplete_policy_warns_without_stopping_install(enabled, state, capsys):
    ns = verifier()
    ns['requests'].get.return_value = Response({'spec': {'feature_status': {'is_enabled': enabled}},
        'status': {'feature_status': {'config': {'state': state}}}})
    assert ns['main']() == 0
    output = capsys.readouterr().out
    assert 'NOT confirmed ready' in output and 'with a Policy Engine readiness warning' in output
    assert 'All checks passed' not in output


def test_enabled_engine_is_confirmed(capsys):
    ns = verifier()
    ns['requests'].get.return_value = Response({'spec': {'feature_status': {'is_enabled': True}},
        'status': {'feature_status': {'config': {'state': 'COMPLETED'}}}})
    assert ns['main']() == 0
    assert 'approval-policy stages are ready' in capsys.readouterr().out


def test_unreadable_status_is_not_success(capsys):
    ns = verifier()
    ns['requests'].get.side_effect = requests.ReadTimeout('busy')
    assert ns['main']() == 0
    assert 'NOT confirmed ready' in capsys.readouterr().out


def test_other_profile_does_not_require_policy():
    ns = verifier()
    ns['CLUSTER_PROFILE'] = 'other'
    assert ns['main']() == 0
    ns['requests'].get.assert_not_called()
