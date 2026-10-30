# Official IsolationHost cell image (`silver-cell:local`).
# IsolationHost bind-mounts the Silver repo at /opt/silver and the challenge at /work.
# Official DSH and native Node dependencies are installed into /opt/silver-runtime
# so Linux cells never load host-OS node_modules from the repo bind-mount.
# Busybox cannot run dsh. LLM keys stay on the host — do not bake secrets here.
#
#   npm run cell:image
#   docker build -f docker/cell/Dockerfile --build-arg NODE_IMAGE=<local-node-image> -t silver-cell:local .
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
LABEL org.silver.cell-runtime=dsh

WORKDIR /opt/silver-runtime
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
RUN npm ci

WORKDIR /work
CMD ["node", "/opt/silver-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js", "--help"]
