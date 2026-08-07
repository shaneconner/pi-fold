import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_agent_live.mjs"


@pytest.mark.slow
@pytest.mark.skipif(
    os.environ.get("QUORUM_RUN_LIVE_PI_TESTS") != "1",
    reason="set QUORUM_RUN_LIVE_PI_TESTS=1 for billable governed-agent acceptance",
)
def test_governed_agent_live_lifecycle_is_sha_bound():
    result = subprocess.run(
        ["node", str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    head = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    assert report["testedCommit"] == head
    assert len(report["testedLaunchContractDigest"]) == 64
    for key in (
        "foregroundRuntimeAttested",
        "foregroundPackageOwnedResume",
        "localReadOnlyBash",
        "isolatedWebSearch",
        "isolatedWebFetch",
        "packageOwnedResume",
        "packageOwnedInterrupt",
        "pausedWasNotSuccess",
    ):
        assert report[key] is True
    assert report["extensionErrors"] == []
