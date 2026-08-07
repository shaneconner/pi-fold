import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_writer_sandbox.mjs"


def test_governed_writer_bash_is_networkless_and_worktree_scoped():
    result = subprocess.run(
        ["node", str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["outsideWriteBlocked"] is True
    assert report["symlinkEscapeBlocked"] is True
    assert report["networkBlocked"] is True
    assert report["hostSocketsHidden"] is True
    assert report["visibleHostSocketBlocked"] is True
    assert report["toolCallHookRewritten"] is True
    assert report["readOnlyDependencyBindsVerified"] is True
    assert report["controlledCommit"] is True
    assert report["dirtyWorktreePreserved"] is True
    assert report["baseDriftPreserved"] is True
    assert report["gitIdentityDriftBlocked"] is True
