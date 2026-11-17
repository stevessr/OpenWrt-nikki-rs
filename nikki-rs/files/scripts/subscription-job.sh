#!/bin/sh
# Keep network operations out of rpcd's synchronous request window.
set -eu
ROOT="${NIKKI_JOB_DIR:-/var/run/nikki-rs/subscription-jobs}"
SERVICE="${NIKKI_SERVICE:-/etc/init.d/nikki-rs}"
section="${2:-}"
case "$section" in ''|*[!a-zA-Z0-9_]*) echo 'Invalid subscription section' >&2; exit 1;; esac
mkdir -p "$ROOT"
state="$ROOT/$section.state"
lock="$ROOT/$section.lock"
case "${1:-}" in
start)
    [ "$(uci -q get "nikki-rs.$section" || true)" = subscription ] || exit 1
    if ! mkdir "$lock" 2>/dev/null; then echo 'Subscription update already running' >&2; exit 1; fi
    printf 'running
' > "$state"
    nohup sh "$0" worker "$section" </dev/null >"$ROOT/$section.log" 2>&1 &
    ;;
worker)
    trap 'rmdir "$lock" 2>/dev/null || :' EXIT
    if "$SERVICE" update_subscription "$section" && [ "$(uci -q get "nikki-rs.$section.success" || true)" = 1 ]; then
        printf 'success
' > "$state"
    else
        printf 'failed
' > "$state"
    fi
    ;;
status)
    set +u
    . /usr/share/libubox/jshn.sh
    job_state=$(cat "$state" 2>/dev/null || echo idle)
    json_init
    json_add_string state "$job_state"
    json_add_string error "$(uci -q get "nikki-rs.$section.error" || true)"
    json_add_string updated "$(uci -q get "nikki-rs.$section.update" || true)"
    json_dump
    ;;
*) exit 2;;
esac
