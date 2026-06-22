"""
Usage:
  python -m hpc_bundler.cli.probe <container_id_or_name> <bundle_dir>
  python -m hpc_bundler.cli.probe --direct <bundle_dir>

--direct: run the probe in the current shell (use when already inside the container).
"""
import json
import subprocess
import sys

from ..docker_manager import DockerManager
from ..env_probe import PROBE_SCRIPT, run_probe, _parse


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--direct":
        bundle_dir = sys.argv[2]
        result = _run_direct(bundle_dir)
    elif len(sys.argv) == 3:
        container_id, bundle_dir = sys.argv[1], sys.argv[2]
        dm = DockerManager()
        result = run_probe(dm, container_id, bundle_dir)
    else:
        print("Usage: probe <container_id> <bundle_dir>  |  probe --direct <bundle_dir>",
              file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2))


def _run_direct(bundle_dir: str) -> dict:
    from pathlib import Path
    import json
    proc = subprocess.run(
        ["bash", "--login", "-c", PROBE_SCRIPT],
        capture_output=True, text=True
    )
    result = _parse(proc.stdout + proc.stderr)
    Path(bundle_dir).mkdir(parents=True, exist_ok=True)
    (Path(bundle_dir) / "probe.json").write_text(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    main()
