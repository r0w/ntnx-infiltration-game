"""Custom networks must never silently select or rename a different VLAN."""
import json
from unittest.mock import Mock
import pytest
from .test_install_task_results import load, Response


def subnet(name, ident):
    return {'name': name, 'extId': ident}


def test_setup_selects_custom_without_rename():
    ns = load('setup_subnets.py')
    ns['SECONDARY_SUBNET_NAME'] = 'Workshop VLAN'
    selected = ns['rename_aux1_to_secondary']([subnet('secondary', 'old'), subnet('Workshop VLAN', 'new')])
    assert selected['extId'] == 'new'
    ns['requests'].put.assert_not_called()


def test_missing_custom_does_not_rename_aux1():
    ns = load('setup_subnets.py')
    ns['SECONDARY_SUBNET_NAME'] = 'Workshop'
    assert ns['rename_aux1_to_secondary']([subnet('aux-1', 'aux'), subnet('Workshop-other', 'wrong')]) is None
    ns['requests'].put.assert_not_called()


def test_setup_preserves_advanced_migration_for_custom():
    ns = load('setup_subnets.py')
    ns['SECONDARY_SUBNET_NAME'] = 'Workshop'
    network = subnet('Workshop', 'custom')
    ns['list_subnets'] = Mock(return_value=[network])
    ns['migrate_secondary_to_advanced'] = Mock(return_value=False)
    ns['create_test_network'] = Mock()
    assert ns['main']() == 1
    ns['migrate_secondary_to_advanced'].assert_called_once_with(network)
    ns['create_test_network'].assert_not_called()


@pytest.mark.parametrize('script', ['setup_subnets.py', 'setup_production_project.py', 'create_prod_vms.py'])
@pytest.mark.parametrize('target,names,expected', [
    ('secondary', ['secondary-abc'], '0'),
    ('secondary', ['secondary-abc', 'SECONDARY'], '1'),
    ('Workshop', ['secondary', 'WORKSHOP'], '1'),
    ('Workshop', ['Workshop-other', 'secondary'], None),
    ('secondary', ['secondary-a', 'secondary-b'], 'ambiguous'),
    ('Workshop', ['Workshop', 'WORKSHOP'], 'ambiguous'),
])
def test_consistent_selection(script, target, names, expected):
    ns = load(script)
    ns['SECONDARY_SUBNET_NAME'] = target
    networks = [subnet(name, str(i)) for i, name in enumerate(names)]
    if script == 'setup_subnets.py':
        def lookup():
            result = ns['rename_aux1_to_secondary'](networks)
            return result['extId'] if result else None
    else:
        if script == 'create_prod_vms.py':
            ns['_req_retry'] = Mock(return_value=Response({'data': networks}))
        else:
            ns['_SESS'] = Mock()
            ns['_SESS'].post.return_value = Response({'entities': [
                {'status': {'name': s['name']}, 'metadata': {'uuid': s['extId']}} for s in networks
            ]})
        def lookup():
            return ns['get_subnet_uuid'](target)
    if expected == 'ambiguous':
        with pytest.raises(ValueError, match='Multiple networks'):
            lookup()
    else:
        assert lookup() == expected


def test_compiled_network_setting_reaches_every_consumer():
    from pathlib import Path
    bp = Path(__file__).resolve().parents[1]
    resources = json.loads((bp / 'blueprint.patched.json').read_text())['spec']['resources']
    profile = resources['app_profile_list'][0]
    variable, = [v for v in profile['variable_list'] if v['name'] == 'GAME_SECONDARY_NETWORK']
    assert variable['value'] == 'secondary'
    serialized = json.dumps(resources)
    assert serialized.count('@@{GAME_SECONDARY_NETWORK}@@') >= 4


@pytest.mark.parametrize('script,page_size', [('create_prod_vms.py', 100), ('setup_production_project.py', 250)])
def test_custom_network_beyond_first_page(script, page_size):
    ns = load(script)
    networks = [subnet('unrelated-%d' % i, str(i)) for i in range(page_size)]
    networks.append(subnet('Workshop', 'chosen'))
    if script == 'create_prod_vms.py':
        ns['_req_retry'] = Mock(side_effect=[Response({'data': networks[:page_size]}), Response({'data': networks[page_size:]})])
    else:
        entities = [{'status': {'name': s['name']}, 'metadata': {'uuid': s['extId']}} for s in networks]
        ns['_SESS'] = Mock()
        ns['_SESS'].post.side_effect = [Response({'entities': entities[:page_size]}), Response({'entities': entities[page_size:]})]
    assert ns['get_subnet_uuid']('Workshop') == 'chosen'
