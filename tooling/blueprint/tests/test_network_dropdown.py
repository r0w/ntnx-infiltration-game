"""Profile changes must not offer the HPOC alias on a shared cluster."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from .test_install_task_results import Response


def script(profile):
    source = (Path(__file__).parents[1] / 'scripts/list_game_networks.py').read_text()
    ns = {}
    exec(source.rsplit('\nmain()', 1)[0], ns)
    ns['CLUSTER_PROFILE'] = profile
    ns['requests'] = SimpleNamespace(get=Mock())
    return ns


def test_hpoc_requires_no_network_request(capsys):
    ns = script('hpoc')
    ns['main']()
    assert capsys.readouterr().out.strip() == 'secondary'
    ns['requests'].get.assert_not_called()


def test_other_lists_internal_vlans_only(capsys):
    ns = script('other')
    ns['requests'].get.return_value = Response({'data': [
        {'name': 'primary-A', 'subnetType': 'VLAN'},
        {'name': 'secondary-A', 'subnetType': 'VLAN'},
        {'name': 'TestNetwork', 'subnetType': 'VLAN', 'isExternal': True},
        {'name': 'overlay', 'subnetType': 'OVERLAY'},
    ]})
    ns['main']()
    assert capsys.readouterr().out.strip() == 'secondary-A,primary-A'


def test_other_reads_subsequent_pages(capsys):
    ns = script('other')
    ns['requests'].get.side_effect = [
        Response({'data': [{'name': 'vlan-%d' % i, 'subnetType': 'VLAN'} for i in range(100)]}),
        Response({'data': [{'name': 'last-page', 'subnetType': 'VLAN'}]}),
    ]
    ns['main']()
    assert 'last-page' in capsys.readouterr().out
    assert ns['requests'].get.call_count == 2


def test_failed_inventory_is_not_an_empty_menu():
    ns = script('other')
    ns['requests'].get.return_value = Response({}, status_code=403)
    with pytest.raises(Exception, match='403'):
        ns['main']()


def test_empty_inventory_is_explicit():
    ns = script('other')
    ns['requests'].get.return_value = Response({'data': []})
    with pytest.raises(Exception, match='No internal VLAN'):
        ns['main']()
