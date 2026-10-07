FROM node:24-trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*
# Pinned: Claude Code flags/output can change between releases.
RUN npm install --global @anthropic-ai/claude-code@2.1.280
WORKDIR /workspace
CMD ["sleep", "infinity"]
