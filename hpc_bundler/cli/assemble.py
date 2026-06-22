"""
Usage: python -m hpc_bundler.cli.assemble <bundle_dir> <output_dir>

Reads dep_tree.json and build_log.json from bundle_dir, renders install.sh
and the Lua modulefile, writes manifest.json and README.md, then creates
the final .tar.gz bundle in output_dir.
"""
import json
import sys
from datetime import date
from pathlib import Path

from ..bundle import create_bundle_tarball
from ..render import render_install_sh, render_modulefile


def main():
    if len(sys.argv) != 3:
        print("Usage: assemble <bundle_dir> <output_dir>", file=sys.stderr)
        sys.exit(1)

    bundle_dir = sys.argv[1]
    output_dir = sys.argv[2]
    bundle = Path(bundle_dir)

    dep_tree_path = bundle / "dep_tree.json"
    build_log_path = bundle / "build_log.json"

    with open(dep_tree_path) as f:
        dep_tree = json.load(f)
    with open(build_log_path) as f:
        build_log = json.load(f)

    target = dep_tree["target"]
    version = dep_tree["version"]

    # 1. Render install.sh
    render_install_sh(str(build_log_path), str(dep_tree_path), str(bundle / "install.sh"))

    # 2. Render modulefile
    modulefile_path = bundle / "modulefiles" / target / f"{version}.lua"
    render_modulefile(str(dep_tree_path), str(modulefile_path))

    # 3. Write manifest.json
    compiler = "gcc (unknown)"
    if build_log.get("steps"):
        first_step = build_log["steps"][0]
        for cmd_entry in first_step.get("commands", []):
            if "gcc" in cmd_entry.get("cmd", "").lower() and cmd_entry.get("stdout"):
                compiler = cmd_entry["stdout"].splitlines()[0][:60]
                break

    manifest = {
        "target": target,
        "version": version,
        "built_for": "x86_64-linux",
        "compiler": compiler,
        "created": date.today().isoformat(),
        "dependencies": [
            {
                "name": d["name"],
                "version": d["version"],
                "source_url": d["source_url"],
                "sha256": d["sha256"],
                "file": d["file"],
                "build_order": d["build_order"],
            }
            for d in dep_tree.get("dependencies", [])
        ],
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # 4. Write README.md
    non_target_deps = [d["name"] for d in dep_tree["dependencies"] if not d.get("is_target")]
    readme = f"""# {target} {version} — Offline HPC Bundle

## What's inside

This bundle contains {target} {version} and all its dependencies, built from
source for AlmaLinux 9.7 (x86_64) using GCC 14.

**Dependencies bundled:** {', '.join(non_target_deps) if non_target_deps else 'none'}

## How to install

Copy this bundle to the target system, then:

```bash
tar xf {target}-{version}-bundle.tar.gz
cd {target}-{version}-bundle
bash install.sh
```

Then load the module:

```bash
module use $HOME/modulefiles
module load {target}/{version}
```

## Customising the install location

```bash
INSTALL_PREFIX=/shared/apps bash install.sh
```
"""
    (bundle / "README.md").write_text(readme)

    # 5. Create tarball
    tarball = create_bundle_tarball(bundle_dir, output_dir)
    print(tarball)


if __name__ == "__main__":
    main()
