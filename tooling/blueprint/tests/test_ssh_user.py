"""Exercise the login guard and the compiled credential/cloud-init contract."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

BP = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('username,valid', [('nutanix', True), ('workshop-user', True), ('root', False), ('Bad User', False), ('-bad', False)])
def test_precreate_validates_username(username, valid):
    script = (BP / 'scripts/validate_ssh_user.py').read_text().replace('@@{NUTANIX.username}@@', username)
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True)
    assert (result.returncode == 0) == valid
    assert ('VM SSH user: ' + username) in result.stdout if valid else '[FAIL]' in result.stdout


@pytest.mark.parametrize('configured,actual,success', [('nutanix', 'nutanix', True), ('workshop-user', 'workshop-user', True), ('workshop-user', 'nutanix', False)])
def test_ssh_guard_stops_mismatched_login(tmp_path, configured, actual, success):
    fake_id = tmp_path / 'id'
    fake_id.write_text('#!/bin/sh\nprintf "%s\\n" "$TEST_ACTUAL_USER"\n')
    fake_id.chmod(0o755)
    script = (BP / 'scripts/check_ssh_user.sh').read_text().replace('@@{NUTANIX.username}@@', configured)
    result = subprocess.run(['bash', '-c', script + '\necho TASK_EXECUTED'], capture_output=True, text=True,
                            env={**os.environ, 'PATH': str(tmp_path) + ':' + os.environ['PATH'], 'TEST_ACTUAL_USER': actual})
    assert (result.returncode == 0) == success
    assert ('TASK_EXECUTED' in result.stdout) == success
    assert f'configured user: {configured}; connected user: {actual}' in result.stdout


def test_compiled_ssh_uses_one_credential():
    path = BP / 'blueprint.patched.json'
    if not path.exists():
        pytest.skip('Compile the blueprint first')
    res = json.loads(path.read_text())['spec']['resources']
    cred, = res['credential_definition_list']
    assert cred['name'] == 'NUTANIX' and cred['username'] == 'nutanix'
    assert cred['editables']['username'] is True
    substrate, = res['substrate_definition_list']
    cloud = substrate['create_spec']['resources']['guest_customization']['cloud_init']['user_data']
    assert 'name: "@@{NUTANIX.username}@@"' in cloud
    assert "sudo -iu '@@{NUTANIX.username}@@'" in cloud
    assert substrate['readiness_probe']['login_credential_local_reference']['name'] == 'NUTANIX'
    tasks = []
    def walk(value):
        if isinstance(value, dict):
            if value.get('type') == 'EXEC':
                tasks.append(value)
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
    walk(res)
    validation = next(t for t in tasks if t['name'] == 'Validate VM SSH user')
    assert 'def _calm_exit' in validation['attrs']['script']
    assert 'import sys' not in validation['attrs']['script']
    ssh = [t for t in tasks if t.get('attrs', {}).get('script_type') == 'sh']
    assert len(ssh) == 5
    for task in ssh:
        assert task['attrs']['login_credential_local_reference']['name'] == 'NUTANIX'
        assert "expected_user='@@{NUTANIX.username}@@'" in task['attrs']['script']
