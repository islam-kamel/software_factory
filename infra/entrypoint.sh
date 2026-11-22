#!/bin/sh
# ============================================================
# entrypoint.sh
# Purpose : Reject unsafe provider key values before NGINX template expansion
# Feature : Phase 3 secret boundary
# Role    : Container entrypoint validation
# API Doc : NGINX official Docker image entrypoint
# ============================================================
set -eu
umask 0077

validate_key() {
    variable_name="$1"
    key_value="$2"
    case "${key_value}" in
        *[!A-Za-z0-9._-]*)
            printf 'Invalid characters in %s\n' "${variable_name}" >&2
            exit 1
            ;;
    esac
}

validate_key OPENROUTER_API_KEY "${OPENROUTER_API_KEY:-}"
validate_key OPENAI_API_KEY "${OPENAI_API_KEY:-}"
validate_key OPENCODE_API_KEY "${OPENCODE_API_KEY:-}"

mkdir -p "${NGINX_ENVSUBST_OUTPUT_DIR:-/etc/nginx/conf.d}"
exec /docker-entrypoint.sh "$@"
