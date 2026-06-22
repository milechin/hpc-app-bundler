import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader


def _get_env() -> Environment:
    templates_dir = Path(__file__).parent / "templates"
    return Environment(loader=FileSystemLoader(str(templates_dir)), keep_trailing_newline=True)


def render_install_sh(build_log_path: str, dep_tree_path: str, output_path: str):
    with open(build_log_path) as f:
        build_log = json.load(f)
    with open(dep_tree_path) as f:
        dep_tree = json.load(f)

    # Container-specific paths baked into build_log commands that must be
    # replaced with shell variables so install.sh works on the enclave.
    bundle_dir_container = str(Path(dep_tree_path).parent)  # e.g. /bundle/zlib-1.3.1-bundle
    install_prefix_container = "/home/builder/pkg"           # hardcoded in workflow

    env = _get_env()
    template = env.get_template("install.sh.j2")
    content = template.render(
        dep_tree=dep_tree,
        build_log=build_log,
        bundle_dir_container=bundle_dir_container,
        install_prefix_container=install_prefix_container,
    )
    Path(output_path).write_text(content)
    Path(output_path).chmod(0o755)


def render_modulefile(dep_tree_path: str, output_path: str):
    with open(dep_tree_path) as f:
        dep_tree = json.load(f)

    runtime_deps = [d for d in dep_tree.get("dependencies", []) if not d.get("is_target")]

    env = _get_env()
    template = env.get_template("modulefile.lua.j2")
    content = template.render(
        target=dep_tree["target"],
        version=dep_tree["version"],
        runtime_deps=runtime_deps,
    )
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(content)
