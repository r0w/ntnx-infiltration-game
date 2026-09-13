"""Activation must not submit duplicate downloads or claim premature readiness."""
from unittest.mock import Mock

import pytest

from .test_install_task_results import load


def feature(state, message='', enabled=False):
    return {'metadata': {'spec_version': 4},
            'spec': {'feature_status': {'is_enabled': enabled}},
            'status': {'feature_status': {'config': {'state': state, 'state_message': message}}}}


def policy():
    ns = load('activate_policy_engine.py')
    ns['CLUSTER_PROFILE'] = 'hpoc'
    ns['DOWNLOAD_POLLS'] = 4
    ns['STARTUP_POLLS'] = 2
    ns['TOTAL_POLLS'] = 6
    ns['put_enable'] = Mock()
    return ns


def test_cold_download_gets_own_budget_and_only_one_enable():
    ns = policy()
    ns['get_feature'] = Mock(side_effect=[(feature(None), None)] +
        [(feature('RUNNING', 'DownloadingImage'), None)] * 3 +
        [(feature('RUNNING', 'StartingServices'), None), (feature('COMPLETED', enabled=True), None)])
    assert ns['main']() == 0
    ns['put_enable'].assert_called_once()
    assert ns['get_feature'].call_count == 6


def test_existing_download_is_monitored_without_resubmission(capsys):
    ns = policy()
    ns['get_feature'] = Mock(return_value=(feature('RUNNING', 'DownloadingImage'), None))
    assert ns['main']() == 0
    ns['put_enable'].assert_not_called()
    assert ns['get_feature'].call_count == 5
    assert 'NOT confirmed ready' in capsys.readouterr().out


@pytest.mark.parametrize('state,enabled', [('COMPLETED', True), (None, True)])
def test_cached_enabled_engine_skips_activation(state, enabled):
    ns = policy()
    ns['get_feature'] = Mock(return_value=(feature(state, enabled=enabled), None))
    assert ns['main']() == 0
    ns['put_enable'].assert_not_called()
    assert ns['get_feature'].call_count == 1


@pytest.mark.parametrize('state,enabled', [('COMPLETED', False), ('ERROR', True), ('RUNNING', True)])
def test_feature_flag_or_completed_state_alone_is_not_ready(state, enabled, capsys):
    ns = policy()
    ns['get_feature'] = Mock(return_value=(feature(state, enabled=enabled), None))
    ns['main']()
    assert '[ready]' not in capsys.readouterr().out


def test_unknown_status_does_not_trigger_mutation():
    ns = policy()
    ns['get_feature'] = Mock(return_value=(None, 'timeout'))
    ns['main']()
    ns['put_enable'].assert_not_called()


def test_lost_enable_response_is_not_retried(capsys):
    import requests
    ns = policy()
    ns['get_feature'] = Mock(return_value=(feature(None), None))
    ns['put_enable'].side_effect = requests.ReadTimeout('response lost')
    ns['main']()
    ns['put_enable'].assert_called_once()
    assert 'NOT confirmed ready' in capsys.readouterr().out


@pytest.mark.parametrize('payload', [None, {}, {'spec': None, 'status': None},
    {'spec': {'feature_status': None}, 'status': {'feature_status': None}}])
def test_missing_enablement_does_not_crash_or_start_activation(payload, capsys):
    ns = policy()
    ns['get_feature'] = Mock(return_value=(payload, None))
    assert ns['main']() == 0
    ns['put_enable'].assert_not_called()
    assert 'NOT confirmed ready' in capsys.readouterr().out

@pytest.mark.parametrize('status', [None, {'feature_status': None}, {'feature_status': {'config': None}}])
def test_null_status_during_polling_does_not_crash(status, capsys):
    ns = policy()
    payload = feature('RUNNING')
    payload['status'] = status
    ns['get_feature'] = Mock(return_value=(payload, None))
    assert ns['wait_until_ready']() is False
    assert '[ready]' not in capsys.readouterr().out
