import docker
from pathlib import Path


SANDBOX_IMAGE = "hpc-bundler-sandbox:latest"
BUNDLE_MOUNT = "/bundle"


class DockerManager:
    def __init__(self):
        self.client = docker.from_env()

    def build_image(self, dockerfile_dir: str):
        self.client.images.build(path=dockerfile_dir, tag=SANDBOX_IMAGE, rm=True)

    def start_container(self, bundle_dir: str, name: str, claude_creds_dir: str = None) -> str:
        Path(bundle_dir).mkdir(parents=True, exist_ok=True)
        volumes = {
            str(Path(bundle_dir).resolve()): {"bind": BUNDLE_MOUNT, "mode": "rw"},
        }
        if claude_creds_dir:
            # Read-only: container can authenticate but cannot modify host credentials
            volumes[str(Path(claude_creds_dir).resolve())] = {"bind": "/root/.claude", "mode": "ro"}
        container = self.client.containers.run(
            SANDBOX_IMAGE,
            command="tail -f /dev/null",
            detach=True,
            name=name,
            volumes=volumes,
            network="bridge",
        )
        return container.id

    def exec(self, container_id: str, command: str, env: dict = None) -> tuple[int, str, str]:
        container = self.client.containers.get(container_id)
        result = container.exec_run(
            ["bash", "--login", "-c", command],
            environment=env or {},
            demux=True,
        )
        stdout = (result.output[0] or b"").decode(errors="replace")
        stderr = (result.output[1] or b"").decode(errors="replace")
        return result.exit_code, stdout, stderr

    def disconnect_network(self, container_id: str):
        container = self.client.containers.get(container_id)
        bridge = self.client.networks.get("bridge")
        bridge.disconnect(container)

    def reconnect_network(self, container_id: str):
        container = self.client.containers.get(container_id)
        bridge = self.client.networks.get("bridge")
        bridge.connect(container)

    def stop_and_remove(self, container_id: str):
        try:
            container = self.client.containers.get(container_id)
            container.stop(timeout=10)
            container.remove()
        except docker.errors.NotFound:
            pass

    def stop_and_remove_by_name(self, name: str):
        try:
            container = self.client.containers.get(name)
            container.stop(timeout=10)
            container.remove()
        except docker.errors.NotFound:
            pass
