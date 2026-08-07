from pathlib import Path
import subprocess


def test_pi_memory_influence_contract():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "scripts" / "verify_pi_memory_influence.mjs")],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=120,
    )
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert '"requestEphemeralProjectMemory": true' in result.stdout
    assert '"actedInfluenceExact": true' in result.stdout
