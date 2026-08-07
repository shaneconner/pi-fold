import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_evidence.mjs"


def test_pi_tool_evidence_is_bounded_immutable_and_frame_guarded():
    result = subprocess.run(
        ["node", str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["utf8Bounded"] is True
    assert report["atomicContentAddressedDedup"] is True
    assert report["immutableBashPin"] is True
    assert report["boundedReadProjection"] is True
    assert report["boundedMcpProjection"] is True
    assert report["boundedAgentProjection"] is True
    assert report["failedEvidenceStayedRaw"] is True
    assert report["mcpFrameGuardBeforeParse"] is True
    assert len(report["digest"]) == 64
