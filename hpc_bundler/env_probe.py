import json
import re
from pathlib import Path

from .docker_manager import DockerManager


PROBE_SCRIPT = r"""
echo "GCC:$(gcc --version 2>/dev/null | head -1 || echo unavailable)"
echo "CMAKE:$(cmake --version 2>/dev/null | head -1 || echo unavailable)"
echo "PYTHON:$(python3 --version 2>/dev/null || echo unavailable)"
echo "PKGCONFIG:$(pkg-config --version 2>/dev/null || echo unavailable)"
ldconfig -p 2>/dev/null | grep -E 'libssl|libz|libffi|libcurl|libm|libpng|libjpeg|libhdf5|libnetcdf|libbz2|liblzma|libreadline|libsqlite3' | awk '{print "LIB:"$NF}' || true
module avail 2>&1 | head -20 || echo "LMOD:unavailable"
"""


def run_probe(dm: DockerManager, container_id: str, bundle_dir: str) -> dict:
    _, stdout, stderr = dm.exec(container_id, PROBE_SCRIPT)
    result = _parse(stdout + stderr)
    Path(bundle_dir).mkdir(parents=True, exist_ok=True)
    probe_path = Path(bundle_dir) / "probe.json"
    probe_path.write_text(json.dumps(result, indent=2))
    return result


def _parse(raw: str) -> dict:
    lines = raw.splitlines()

    def extract(prefix):
        for line in lines:
            if line.startswith(prefix):
                return line[len(prefix):].strip()
        return None

    gcc = extract("GCC:") or "unavailable"
    cmake = extract("CMAKE:")
    python = extract("PYTHON:") or "unavailable"
    pkgconfig_raw = extract("PKGCONFIG:")
    pkgconfig = bool(pkgconfig_raw and pkgconfig_raw != "unavailable")

    system_libraries = []
    for line in lines:
        if line.startswith("LIB:"):
            lib_path = line[4:].strip()
            # extract base name, e.g. libssl.so.3 -> libssl
            base = Path(lib_path).name
            name = re.split(r"\.so", base)[0]
            system_libraries.append({"name": name, "path": lib_path, "present": True})

    lmod_line = next((l for l in lines if "LMOD:" in l or "module" in l.lower()), "")
    lmod_available = "unavailable" not in lmod_line.lower() and bool(lmod_line)

    return {
        "gcc_version": gcc,
        "cmake_version": cmake,
        "python_version": python,
        "pkg_config_available": pkgconfig,
        "system_libraries": system_libraries,
        "lmod_available": lmod_available,
        "module_avail_output": lmod_line,
        "raw_output": raw,
    }
