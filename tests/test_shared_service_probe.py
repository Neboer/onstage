import importlib.util
from pathlib import Path
import sys

import pytest


SPEC = importlib.util.spec_from_file_location("onstage_shared_service_probe", Path(__file__).resolve().parents[1] / "tools" / "shared_service_probe.py")
probe_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = probe_module
SPEC.loader.exec_module(probe_module)


@pytest.mark.parametrize("flags, enabled", [([], False), (["--use-env-proxy"], True)])
def test_proxy_requires_explicit_opt_in_and_is_declared_in_report(flags, enabled):
    args = probe_module.build_parser().parse_args([
        "--url", "https://demo.example.org", "--source", "isolated-configuration-test",
        "--output", "unused-no-network-report.json", *flags,
    ])
    assert args.use_env_proxy is enabled
    probe = probe_module.Probe(args)
    try:
        assert probe.report["environment_proxy_enabled"] is enabled
        assert probe.report["direct_connection_requested"] is (not enabled)
        assert probe.report["site_bypass_used"] is False
        assert probe.report["platform_sign_in_used"] is False
        assert probe.report["scope"]["mainland_location_verified"] is False
        assert probe.report["scope"]["physical_devices_executed"] is False
        assert probe.requests == 0
    finally:
        for person in probe.people:
            person.client.close()
