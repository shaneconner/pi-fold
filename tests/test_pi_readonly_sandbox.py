import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_readonly_sandbox.mjs"


def test_governed_read_only_bash_is_useful_without_mutation_access():
    result = subprocess.run(
        ["node", str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report == {
        "ok": True,
        "sourceReadable": True,
        "checksExecutable": True,
        "projectWriteBlocked": True,
        "dependencyWritesBlocked": True,
        "ephemeralTmpWritable": True,
        "environmentScrubbed": True,
        "networkBlocked": True,
        "unixSocketBlocked": True,
        "toolCallHookRewritten": True,
        "localReadPermissive": True,
        "localWebToolsAvailable": True,
        "webSearchIsolated": True,
        "piRuntimeReadable": True,
    }
