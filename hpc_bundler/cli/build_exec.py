"""
Usage:
  python -m hpc_bundler.cli.build_exec [--network-isolated] <commands.json> <container_id>
  python -m hpc_bundler.cli.build_exec [--network-isolated] --direct <commands.json>

--direct:            execute commands in the current shell (use when already inside the container).
--network-isolated:  wrap each command in a new user+network namespace (unshare --user --net)
                     so only loopback is available. Any outbound internet attempt fails immediately.
                     Has no effect in docker mode (use docker network disconnect instead).
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from ..docker_manager import DockerManager


GCC14_ENV = {
    "PATH": "/opt/rh/gcc-toolset-14/root/usr/bin:/usr/local/bin:/usr/bin:/bin",
    "CC": "/opt/rh/gcc-toolset-14/root/usr/bin/gcc",
    "CXX": "/opt/rh/gcc-toolset-14/root/usr/bin/g++",
    "FC": "/opt/rh/gcc-toolset-14/root/usr/bin/gfortran",
}


def main():
    network_isolated = "--network-isolated" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--network-isolated"]

    if len(args) == 2 and args[0] == "--direct":
        commands_path = args[1]
        run_fn = lambda cmd: _exec_direct(cmd, network_isolated=network_isolated)
    elif len(args) == 2:
        commands_path = args[0]
        container_id = args[1]
        dm = DockerManager()
        run_fn = lambda cmd: _exec_docker(dm, container_id, cmd)
    else:
        print("Usage: build_exec [--network-isolated] <commands.json> <container_id>  |  build_exec [--network-isolated] --direct <commands.json>",
              file=sys.stderr)
        sys.exit(1)

    bundle_dir = str(Path(commands_path).parent)
    build_log_path = Path(bundle_dir) / "build_log.json"

    with open(commands_path) as f:
        payload = json.load(f)

    step = {
        "package_name": payload["package_name"],
        "package_version": payload["package_version"],
        "commands": [],
        "success": True,
        "duration_seconds": 0,
    }

    start = time.time()
    for cmd in payload["commands"]:
        t0 = time.time()
        exit_code, stdout, stderr = run_fn(cmd)
        step["commands"].append({
            "cmd": cmd,
            "exit_code": exit_code,
            "stdout": stdout[-4000:],
            "stderr": stderr[-4000:],
            "duration_seconds": round(time.time() - t0, 2),
        })
        if exit_code != 0:
            step["success"] = False
            step["failed_command"] = cmd
            step["last_stderr"] = stderr[-2000:]
            break

    step["duration_seconds"] = round(time.time() - start, 2)

    log = json.loads(build_log_path.read_text()) if build_log_path.exists() else {"steps": []}
    log["steps"].append(step)
    build_log_path.write_text(json.dumps(log, indent=2))

    print(json.dumps(step, indent=2))
    sys.exit(0 if step["success"] else 1)


def _exec_docker(dm, container_id, cmd):
    return dm.exec(container_id, cmd, env=GCC14_ENV)


def _exec_direct(cmd, network_isolated=False):
    env = {**os.environ, **GCC14_ENV}
    if network_isolated:
        # Run in a new user+network namespace: builder maps to root inside,
        # only loopback is available — any outbound internet attempt fails immediately.
        full_cmd = f"ip link set lo up 2>/dev/null; {cmd}"
        argv = ["unshare", "--user", "--map-root-user", "--net",
                "bash", "--login", "-c", full_cmd]
    else:
        argv = ["bash", "--login", "-c", cmd]
    proc = subprocess.run(argv, capture_output=True, text=True, env=env)
    return proc.returncode, proc.stdout, proc.stderr


if __name__ == "__main__":
    main()
