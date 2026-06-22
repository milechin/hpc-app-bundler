FROM almalinux:9.7

# Enable EPEL and other repos
RUN dnf install -y epel-release && \
    dnf install -y dnf-plugins-core && \
    dnf config-manager --set-enabled crb && \
    dnf clean all

# Core dev tools
RUN dnf install -y --allowerasing \
    gcc-toolset-14-gcc gcc-toolset-14-gcc-c++ gcc-toolset-14-binutils \
    gcc-toolset-14-gcc-gfortran \
    make cmake autoconf automake libtool \
    git wget curl \
    && dnf clean all

ENV PATH=/opt/rh/gcc-toolset-14/root/usr/bin:$PATH

# Python
RUN dnf install -y \
    python3 python3-devel python3-pip \
    python3.11 python3.11-libs \
    python3-numpy python3-pyyaml python3-requests \
    && dnf clean all

# Java
RUN dnf install -y \
    java-1.8.0-openjdk java-1.8.0-openjdk-devel \
    java-17-openjdk-headless java-17-openjdk-devel \
    && dnf clean all

# Scientific / math libraries
RUN dnf install -y \
    openblas openblas-openmp \
    lapack blas \
    fftw fftw-devel \
    hdf5 hdf5-devel \
    netcdf netcdf-devel \
    boost boost-devel \
    && dnf clean all

# Common tools
RUN dnf install -y \
    htop tmux screen vim emacs \
    jq tree lsof strace \
    p7zip zip unzip \
    rsync nmap \
    && dnf clean all

# Apptainer (Singularity)
RUN dnf install -y apptainer && dnf clean all

# R build dependencies
RUN dnf install -y \
    readline-devel \
    ncurses-devel \
    libX11-devel \
    libXt-devel \
    zlib-devel \
    bzip2-devel \
    xz-devel \
    pcre2-devel \
    libcurl-devel \
    openssl-devel \
    libpng-devel \
    libjpeg-turbo-devel \
    libtiff-devel \
    valgrind-devel \
    cairo-devel \
    pango-devel \
    libicu-devel \
    tcl-devel \
    tk-devel \
    libgomp \
    texinfo \
    perl \
    && dnf clean all

# lmod — required for module load/avail validation in Phase 2
RUN dnf install -y lua lua-devel lua-posix tcl bc && \
    curl -fsSL https://github.com/TACC/Lmod/archive/refs/tags/8.7.30.tar.gz -o /tmp/lmod.tar.gz && \
    tar xf /tmp/lmod.tar.gz -C /tmp && \
    cd /tmp/Lmod-8.7.30 && \
    ./configure --prefix=/opt/apps && \
    make install && \
    ln -s /opt/apps/lmod/lmod/init/bash /etc/profile.d/z00_lmod.sh && \
    rm -rf /tmp/lmod* && \
    dnf clean all

# Node.js + Claude Code CLI (for --dangerously-skip-permissions isolated builds)
RUN curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && \
    dnf install -y nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    dnf clean all

# Prevent Claude Code from auto-updating (breaks air-gapped environments)
# and disable telemetry/error reporting traffic.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Organization policy — applied at highest precedence, overrides all user settings.
# Disables web search during builds (sources come from dep_tree.json only).
RUN mkdir -p /etc/claude-code
COPY managed-settings.json /etc/claude-code/managed-settings.json

# Bake in the hpc-bundler project so the container is fully self-contained.
# Workflows, commands, and Python helpers are all available at /workspace.
# Note: .claude/settings.json is intentionally excluded — it contains host paths.
COPY hpc_bundler/ /workspace/hpc_bundler/
COPY pyproject.toml /workspace/
COPY .claude/workflows/ /workspace/.claude/workflows/
COPY .claude/commands/ /workspace/.claude/commands/
RUN python3.11 -m ensurepip --upgrade && python3.11 -m pip install -e /workspace/

# Non-root user — --dangerously-skip-permissions refuses to run as root
RUN useradd -m -s /bin/bash -u 1000 builder && \
    chown -R builder:builder /workspace

USER builder
WORKDIR /workspace

SHELL ["/bin/bash", "--login", "-c"]
ENTRYPOINT ["/bin/bash", "--login"]