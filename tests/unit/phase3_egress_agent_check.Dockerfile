# ============================================================
# phase3_egress_agent_check.Dockerfile
# Purpose : Build an isolated Linux OpenCode egress acceptance image
# Feature : Agent execution security
# Role    : Integration Test Image
# API Doc : https://opencode.ai/docs
# ============================================================
FROM --platform=$TARGETPLATFORM node:26.13.1-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends bubblewrap ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global --prefix /opt/opencode @opencode/cli@2.3.2 \
  && /opt/opencode/bin/opencode --version

COPY adapter /opt/software-factory-check
COPY node_modules /opt/software-factory-check/node_modules
COPY phase3_egress_agent_check_entrypoint.cjs /opt/software-factory-check/entrypoint.cjs

ENTRYPOINT ["/usr/local/bin/node", "/opt/software-factory-check/entrypoint.cjs"]
