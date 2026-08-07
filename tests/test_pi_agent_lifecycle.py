import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_agent_lifecycle.mjs"


def test_governed_agent_interrupt_and_resume_stay_package_owned():
    result = subprocess.run(
        ["node", str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    tested_commit = report.pop("testedCommit")
    assert len(tested_commit) == 40 and all(char in "0123456789abcdef" for char in tested_commit)
    assert report == {
        "ok": True,
        "packageOwnedResume": True,
        "outputConfined": True,
        "terminalEvidenceReconciled": True,
        "terminalFailureEvidenceRejected": True,
        "stoppedNonResumable": True,
        "writerRevivalBlocked": True,
        "indexedParallelResume": True,
        "packageOwnedInterrupt": True,
        "ownershipPersisted": True,
    }
