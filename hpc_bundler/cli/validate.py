"""
Usage:
  python -m hpc_bundler.cli.validate <container_id> <dep_tree.json> [--install-prefix <prefix>]
  python -m hpc_bundler.cli.validate --direct <dep_tree.json> [--install-prefix <prefix>]

--direct: run checks in the current shell (use when already inside the container).
--install-prefix: where packages were installed (default: /home/builder/pkg)

The ldd and version checks run with LD_LIBRARY_PATH set from all dependency install
prefixes, simulating what `module load` does on the enclave. Binaries do NOT need
RPATH embedded — the module system handles runtime library paths.

The network_cut check behaves differently by mode:
  --direct (container-native): verifies that `unshare --user --net` creates an isolated
    namespace (the same mechanism build_exec --network-isolated uses). Required, not advisory.
  docker mode: checks if the container itself is offline. Advisory if it is not, since the
    host-based workflow may or may not have disconnected the container network.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

from ..docker_manager import DockerManager


def _run_cmd_docker(dm, container_id, cmd):
    _, stdout, stderr = dm.exec(container_id, cmd)
    return stdout, stderr


def _run_cmd_direct(cmd):
    proc = subprocess.run(["bash", "--login", "-c", cmd], capture_output=True, text=True)
    return proc.stdout, proc.stderr


def main():
    args = sys.argv[1:]
    install_prefix = "/home/builder/pkg"

    # Parse --install-prefix from anywhere in args
    if "--install-prefix" in args:
        idx = args.index("--install-prefix")
        install_prefix = args[idx + 1]
        args = args[:idx] + args[idx + 2:]

    if len(args) == 2 and args[0] == "--direct":
        dep_tree_path = args[1]
        run_cmd = _run_cmd_direct
        direct_mode = True
    elif len(args) == 2:
        container_id = args[0]
        dep_tree_path = args[1]
        dm = DockerManager()
        run_cmd = lambda cmd: _run_cmd_docker(dm, container_id, cmd)
        direct_mode = False
    else:
        print(
            "Usage: validate [--install-prefix <p>] <container_id> <dep_tree.json>\n"
            "       validate [--install-prefix <p>] --direct <dep_tree.json>",
            file=sys.stderr,
        )
        sys.exit(1)

    bundle_dir = str(Path(dep_tree_path).parent)

    with open(dep_tree_path) as f:
        dep_tree = json.load(f)

    # Build LD_LIBRARY_PATH from all dep install prefixes — simulates `module load`.
    # Binaries need no RPATH; the module system sets these paths on the enclave.
    lib_paths = []
    for dep in dep_tree["dependencies"]:
        dep_prefix = f"{install_prefix}/{dep['name']}/{dep['version']}"
        lib_paths += [f"{dep_prefix}/lib", f"{dep_prefix}/lib64"]
    ld_lib_path = ":".join(lib_paths)

    checks = []

    # Network isolation check.
    # In direct mode (container-native): the container itself retains internet access
    # (the Claude agent needs it), so checking the container's connectivity is meaningless.
    # Instead, verify that unshare --user --net works — the same mechanism build_exec uses
    # to isolate each build command. A curl inside the namespace should be OFFLINE.
    # In docker mode: check if the workflow has disconnected the container's network;
    # advisory because host-based workflow may or may not have done so.
    if direct_mode:
        stdout, _ = run_cmd(
            "unshare --user --map-root-user --net bash -c "
            "'ip link set lo up 2>/dev/null; curl -s --max-time 3 http://1.1.1.1 && echo ONLINE || echo OFFLINE'"
        )
        isolation_works = "OFFLINE" in stdout
        checks.append({
            "check_name": "network_cut",
            "command": "unshare --user --map-root-user --net curl http://1.1.1.1",
            "stdout": stdout.strip(),
            "passed": isolation_works,
            "advisory": False,
            "note": "Verifies unshare --net namespace isolation (used by build_exec --network-isolated)",
        })
    else:
        for attempt in range(2):
            stdout, _ = run_cmd("curl -s --max-time 5 http://1.1.1.1 && echo ONLINE || echo OFFLINE")
            if "OFFLINE" in stdout:
                break
            if attempt == 0:
                time.sleep(2)
        network_offline = "OFFLINE" in stdout
        checks.append({
            "check_name": "network_cut",
            "command": "curl -s --max-time 5 http://1.1.1.1",
            "stdout": stdout.strip(),
            "passed": network_offline,
            "advisory": not network_offline,
        })

    target = dep_tree["target"]
    version = dep_tree["version"]
    prefix = f"{install_prefix}/{target}/{version}"

    # Check that the install prefix exists at all
    stdout_prefix, _ = run_cmd(f"test -d {prefix} && echo EXISTS || echo MISSING")
    prefix_exists = "EXISTS" in stdout_prefix

    # Binary or library exists — check both lib/ and lib64/ (cmake defaults to lib64 on x86_64)
    stdout_bin, _ = run_cmd(f"ls {prefix}/bin/ 2>/dev/null | head -5")
    stdout_lib, _ = run_cmd(
        f"{{ ls {prefix}/lib/ 2>/dev/null; ls {prefix}/lib64/ 2>/dev/null; }}"
        f" | grep -cE '\\.(so|a)$' || echo 0"
    )
    has_bin = bool(stdout_bin.strip())
    has_lib = stdout_lib.strip() not in ("", "0")
    checks.append({
        "check_name": "binary_exists",
        "command": f"ls {prefix}/bin/ && ls {prefix}/lib/ && ls {prefix}/lib64/",
        "stdout": f"bin: {stdout_bin.strip() or '(empty)'} | lib count: {stdout_lib.strip()}",
        "passed": prefix_exists and (has_bin or has_lib),
        "note": "library-only package (no bin/)" if (not has_bin and has_lib) else "",
    })

    # No missing shared libraries — run ldd with LD_LIBRARY_PATH set from all dep prefixes,
    # matching the runtime environment that `module load` establishes on the enclave.
    stdout, _ = run_cmd(
        f"( export LD_LIBRARY_PATH=\"{ld_lib_path}\";"
        f" find {prefix} \\( -name '*.so' -o -name '*.so.*' \\) 2>/dev/null | head -1"
        f" | xargs -r ldd 2>/dev/null | grep 'not found' | wc -l )"
    )
    checks.append({
        "check_name": "no_missing_libs",
        "command": f"ldd check on {prefix} (with module LD_LIBRARY_PATH)",
        "stdout": stdout.strip(),
        "passed": stdout.strip() == "0",
    })

    # Version invocation — skip gracefully if there is no bin/ (library-only package)
    if has_bin:
        stdout, _ = run_cmd(
            f"( export LD_LIBRARY_PATH=\"{ld_lib_path}\";"
            f" {prefix}/bin/{target} --version 2>/dev/null | head -3"
            f" || {prefix}/bin/{target} -V 2>/dev/null | head -3 )"
        )
        version_passed = bool(stdout.strip())
        version_stdout = stdout.strip()
    else:
        version_passed = True
        version_stdout = "(skipped — library-only package, no bin/)"
    checks.append({
        "check_name": "version_check",
        "command": f"{prefix}/bin/{target} --version",
        "stdout": version_stdout,
        "passed": version_passed,
    })

    required_checks = ["network_cut", "binary_exists", "no_missing_libs", "version_check"]
    success = all(
        c["passed"] or c.get("advisory", False)
        for c in checks if c["check_name"] in required_checks
    )
    failed = [
        c["check_name"] for c in checks
        if c["check_name"] in required_checks and not c["passed"] and not c.get("advisory", False)
    ]

    result = {
        "success": success,
        "checks": checks,
        "summary": "All required checks passed." if success else f"Failed: {', '.join(failed)}",
        "install_prefix": prefix,
        "missing_libraries": [],
        "missing_binaries": [],
    }

    out_path = Path(bundle_dir) / "validation.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
