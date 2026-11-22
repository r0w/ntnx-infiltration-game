"""The NKP deployment must remain runnable after shared NCP script changes."""
from .test_compile_output_shape import compiled_bp


def test_nkp_selects_an_image_containing_the_bootcamp(compiled_bp):
    profiles = compiled_bp['spec']['resources']['app_profile_list']
    profile = next(p for p in profiles if p['name'] == 'NKPFundamentals')
    variables = {v['name']: v.get('value') for v in profile['variable_list']}
    assert variables['GAME_PACK'] == 'nkp-bootcamp'
    assert variables['IMAGE_TAG'] == 'nkp'
    # The shared container script reads this even though NKP does not use it.
    assert 'GAME_SECONDARY_NETWORK' in variables


def test_nkp_install_and_update_use_the_nkp_vm_address(compiled_bp):
    resources = compiled_bp['spec']['resources']
    package = next(p for p in resources['package_definition_list'] if p['name'] == 'NKP Game Content')
    profile = next(p for p in resources['app_profile_list'] if p['name'] == 'NKPFundamentals')
    runbooks = [package['options']['install_runbook']]
    runbooks += [action['runbook'] for action in profile['action_list']]
    scripts = [task['attrs']['script'] for runbook in runbooks
               for task in runbook['task_definition_list']
               if task.get('attrs', {}).get('script_type') == 'sh']
    assert len(scripts) == 6
    assert all('@@{VM.address}@@' not in script for script in scripts)
    telemetry = [script for script in scripts if 'NIG_DEPLOYMENT_IP=' in script]
    assert len(telemetry) == 3  # install, Update Game, Refresh Kubeconfig
    assert all('NIG_DEPLOYMENT_IP=@@{NkpVM.address}@@' in script for script in telemetry)
    install = next(script for script in telemetry if 'GAME_PACK=' in script)
    assert 'NKP_KUBECONFIG=/data/nkp-kubeconfig' in install
