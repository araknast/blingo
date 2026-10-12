# ArtifactFS mounts a fork's env branch lazily (see ENV_MOUNT_SH). No release binaries: built here, pinned.
FROM golang:1.26-alpine AS artifact-fs
RUN apk add --no-cache git \
	&& git clone -q https://github.com/cloudflare/artifact-fs /src \
	&& cd /src && git checkout -q 2b87a48691ef4ae82d391b7bbe4976c06c7fadf7 \
	&& CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /artifact-fs ./cmd/artifact-fs

FROM node:24-alpine
# GNU coreutils/findutils/util-linux: the env scripts need split --filter, mountpoint and findmnt.
RUN apk add --no-cache bash git ripgrep libgcc libstdc++ fuse3 coreutils findutils util-linux
# Pinned: Claude Code flags/output can change between releases. On Alpine it needs the system ripgrep.
RUN npm install --global @anthropic-ai/claude-code@2.1.280
ENV USE_BUILTIN_RIPGREP=0
COPY --from=artifact-fs /artifact-fs /usr/local/bin/artifact-fs
WORKDIR /workspace
CMD ["sleep", "infinity"]
