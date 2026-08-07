import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_pi_interactions.mjs"


def test_pi_interaction_packages_reload_and_local_voice():
    result = subprocess.run(
        ["node", str(SCRIPT)], cwd=ROOT, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(result.stdout)
    transcript = report.pop("voiceLocalTranscript").upper()
    version = report.pop("piVersion")
    assert "EARLY NIGHTFALL" in transcript and "YELLOW LAMPS" in transcript
    assert len(version.split(".")) >= 3 and all(part.isdigit() for part in version.split(".")[:3])
    active_context_enabled = report["activeContextEnabled"]
    expected_commands = ["plan", "todos", "voice", "quorum-status", "agents", "reload-runtime"]
    if active_context_enabled:
        expected_commands.extend(["quorum-context", "fold-context"])
    assert report == {
        "ok": True,
        "askUserQuestion": "rpc-cancelled-cleanly",
        "planMode": "activated-and-exited",
        "todoReloadReplay": True,
        "reloadToolMethod": "tool-context",
        "activeContextEnabled": active_context_enabled,
        "automaticNativeCompaction": (
            "disabled-and-guarded" if active_context_enabled else "disabled-with-handler-offline"
        ),
        "commandsAfterReload": expected_commands,
    }
