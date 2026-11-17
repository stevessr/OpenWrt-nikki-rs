#!/bin/sh
# Manage an unpackaged clash-rs override without modifying /usr/bin/clash-rs.
set -eu
CORE_DIR="${NIKKI_CORE_DIR:-/etc/nikki-rs/core}"
RUN_DIR="${NIKKI_RUN_DIR:-/etc/nikki-rs/run}"
SERVICE="${NIKKI_SERVICE:-/etc/init.d/nikki-rs}"
PACKAGED="${NIKKI_PACKAGED_CORE:-/usr/bin/clash-rs}"
ACTIVE="$CORE_DIR/clash-rs"; PREVIOUS="$CORE_DIR/clash-rs.previous"
CURRENT_META="$CORE_DIR/current"; PREVIOUS_META="$CORE_DIR/previous"
LOG="$CORE_DIR/update.log"; STATE="$CORE_DIR/operation.state"
STAGE=''; LOCK="$CORE_DIR/.update.lock"
message() { printf '%s\n' "$*" >&2; if [ "${CORE_WORKER:-0}" != 1 ] && [ -d "$CORE_DIR" ]; then printf '%s\n' "$*" >> "$LOG" || :; fi; }
fail() { message "ERROR: $*"; exit 1; }
validate_tag() { case "$1" in latest) return 0;; v*) check="${1#v}";; *) fail "Release tag must be latest or start with v";; esac; case "$check" in ''|*[!A-Za-z0-9._-]*) fail "Invalid release tag";; esac; }
write_state() { tmp="$STATE.tmp.$$"; printf 'state=%s\noperation=%s\nstarted=%s\nfinished=%s\nmessage=%s\n' "$1" "$2" "${3:-}" "${4:-}" "${5:-}" > "$tmp"; mv -f "$tmp" "$STATE"; }
cleanup() { [ -z "$STAGE" ] || rm -rf "$STAGE"; if [ "${CORE_WORKER:-0}" != 1 ]; then [ ! -d "$LOCK" ] || rmdir "$LOCK" 2>/dev/null || :; fi; }
lock_core() { mkdir -p "$CORE_DIR"; if [ "${CORE_WORKER:-0}" != 1 ]; then mkdir "$LOCK" 2>/dev/null || fail "Another core operation is running"; fi; trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; }
is_running() { [ -x "$SERVICE" ] && "$SERVICE" status >/dev/null 2>&1; }
restart_running() { [ "$WAS_RUNNING" = 1 ] || return 0; "$SERVICE" restart >/dev/null 2>&1 || return 1; i=0; while [ "$i" -lt 6 ]; do is_running && return 0; sleep 1; i=$((i+1)); done; return 1; }
arch_target() { case "$(uname -m)" in aarch64|arm64) echo aarch64-unknown-linux-musl;; x86_64|amd64) echo x86_64-unknown-linux-musl;; armv7*|armv8l|armhf) echo armv7-unknown-linux-musleabihf;; riscv64) echo riscv64gc-unknown-linux-musl;; i?86) echo i686-unknown-linux-musl;; *) fail "Unsupported CPU architecture: $(uname -m)";; esac; }
get_variant() { value="${1:-$(uci -q get nikki-rs.core_update.variant 2>/dev/null || echo minimal)}"; case "$value" in minimal|standard) printf '%s\n' "$value";; *) fail "Invalid core variant";; esac; }
status() { binary="$PACKAGED"; origin=package; [ ! -x "$ACTIVE" ] || { binary="$ACTIVE"; origin=override; }; printf 'origin=%s\npath=%s\n' "$origin" "$binary"; if [ -x "$binary" ]; then "$binary" -v 2>&1 | head -n 1 || :; fi; [ ! -f "$CURRENT_META" ] || cat "$CURRENT_META"; if [ -f "$STATE" ]; then cat "$STATE"; else printf 'state=idle\n'; fi; }
log_output() { [ -f "$LOG" ] || exit 0; tail -c 16384 "$LOG"; }
restore_previous() { if [ -f "$PREVIOUS" ]; then mv -f "$PREVIOUS" "$ACTIVE"; else rm -f "$ACTIVE"; fi; if [ -f "$PREVIOUS_META" ]; then mv -f "$PREVIOUS_META" "$CURRENT_META"; else rm -f "$CURRENT_META"; fi; }
local_proxy() {
    if [ -n "${NIKKI_LOCAL_HTTP_PROXY:-}" ]; then
        printf '%s\n' "$NIKKI_LOCAL_HTTP_PROXY"
        return 0
    fi
    port="$(uci -q get nikki-rs.mixin.mixed_port 2>/dev/null || :)"
    case "$port" in ''|*[!0-9]*) return 1;; esac
    printf 'http://127.0.0.1:%s\n' "$port"
}

fetch_metadata() {
    if curl --proto '=https' --proto-redir '=https' -fLsS --retry 2 --connect-timeout 10 --max-time 40 "$release_api" -o "$STAGE/release.json"; then
        return 0
    fi
    proxy="$(local_proxy)" || return 1
    rm -f "$STAGE/release.json"
    curl --proto '=https' --proto-redir '=https' -fLsS --retry 2 --connect-timeout 10 --max-time 40 --proxy "$proxy" "$release_api" -o "$STAGE/release.json"
}

fetch_archive() {
    proxy="$(local_proxy)" || proxy=''
    message "Stage: archive download via configured local proxy (bounded retries/timeouts)"
    if curl --proto '=https' --proto-redir '=https' -fLsS --retry 2 --retry-delay 1 --connect-timeout 8 --max-time 90 --proxy "$proxy" "$url" -o "$STAGE/core.tar.gz"; then return 0; fi
    rm -f "$STAGE/core.tar.gz"; message "Stage: proxy download failed; retrying archive directly"
    curl --noproxy '*' --proto '=https' --proto-redir '=https' -fLsS --retry 2 --retry-delay 1 --connect-timeout 10 --max-time 120 "$url" -o "$STAGE/core.tar.gz"
}
do_update() {
    variant="$(get_variant "${1:-}")"; tag="${2:-latest}"
    validate_tag "$tag"
    triple="$(arch_target)"; case "$variant:$triple" in standard:riscv64*|standard:i686*) fail "Upstream has no standard asset for $triple";; esac
    lock_core; STAGE="$(mktemp -d "$CORE_DIR/.stage.XXXXXX")" || fail "Cannot allocate staging directory"
    release_api="https://api.github.com/repos/CHKayanami/clash-rs/releases"; [ "$tag" != latest ] || release_api="$release_api/latest"; [ "$tag" = latest ] || release_api="$release_api/tags/$tag"
    message "Stage: fetching release metadata"
    fetch_metadata || fail "Could not fetch release metadata directly or via local proxy"
    published_tag="$(jsonfilter -i "$STAGE/release.json" -e '@.tag_name')"
    case "$published_tag" in v*) check="${published_tag#v}";; *) check="$published_tag";; esac; case "$check" in ''|*[!A-Za-z0-9._-]*) fail "Release API returned invalid tag";; esac
    if [ "$tag" != latest ] && [ "$tag" != "$published_tag" ]; then fail "Release tag does not match requested version"; fi
    tag="$published_tag"; asset="clash-rs-$variant-$triple.tar.gz"; url="https://github.com/CHKayanami/clash-rs/releases/download/$tag/$asset"
    message "Stage: downloading $asset ($tag)"; fetch_archive || fail "Core download failed via proxy and direct fallback"
    jshn_library="${NIKKI_JSHN_LIBRARY:-/usr/share/libubox/jshn.sh}"
    [ -f "$jshn_library" ] || fail "jshn.sh is required to validate release asset digest"
    set +u
    . "$jshn_library"; json_load "$(cat "$STAGE/release.json")"; json_select assets; json_get_keys indexes; digest=''; found=0
    for index in $indexes; do json_select "$index"; json_get_var name name; if [ "$name" = "$asset" ]; then found=1; json_get_var digest digest; json_select ..; break; fi; json_select ..; done
    [ "$found" = 1 ] || fail "Upstream release has no asset for $asset"
    case "$digest" in sha256:*) expected="${digest#sha256:}";; '') fail "Release asset is missing its SHA256 digest";; *) fail "Unexpected digest format from release API";; esac
    case "$expected" in ''|*[!a-fA-F0-9]*) fail "Invalid SHA256 digest";; esac; [ "${#expected}" -eq 64 ] || fail "Invalid SHA256 digest length"
    actual="$(sha256sum "$STAGE/core.tar.gz" | cut -d ' ' -f 1)"; [ "$actual" = "$expected" ] || fail "SHA256 digest mismatch"
    message "Stage: validating and extracting archive"
    member="$(tar -tzf "$STAGE/core.tar.gz" | grep -E '(^|/)clash-rs$' | head -n 1)"; [ -n "$member" ] || fail "Archive does not contain clash-rs"
    tar -xOzf "$STAGE/core.tar.gz" "$member" > "$STAGE/clash-rs" || fail "Extraction failed"; chmod 755 "$STAGE/clash-rs"; "$STAGE/clash-rs" -v >/dev/null 2>&1 || fail "Downloaded core is not executable on this router"
    if [ -f "$RUN_DIR/config.yaml" ]; then timeout 35 "$STAGE/clash-rs" -d "$RUN_DIR" -t > "$STAGE/test.log" 2>&1 || { cat "$STAGE/test.log" >&2; fail "Downloaded core rejected current configuration or timed out"; }; fi
    WAS_RUNNING=0; if is_running; then WAS_RUNNING=1; fi; rm -f "$PREVIOUS" "$PREVIOUS_META"
    if [ -f "$ACTIVE" ]; then cp -p "$ACTIVE" "$PREVIOUS" || fail "Cannot back up previous override"; fi; if [ -f "$CURRENT_META" ]; then cp -p "$CURRENT_META" "$PREVIOUS_META" || fail "Cannot back up previous metadata"; fi
    mv -f "$STAGE/clash-rs" "$ACTIVE" || { restore_previous; fail "Could not install new core"; }; printf 'variant=%s\ntag=%s\n' "$variant" "$tag" > "$CURRENT_META"
    if ! restart_running; then message "New core failed to start: restoring previous core"; restore_previous; restart_running || message "WARNING: automatic service recovery failed"; fail "Core update rolled back"; fi
    message "Core updated to $tag ($variant)"
}
do_rollback() {
    lock_core; [ -f "$ACTIVE" ] || fail "No override installed"; WAS_RUNNING=0; if is_running; then WAS_RUNNING=1; fi; STAGE="$(mktemp -d "$CORE_DIR/.stage.XXXXXX")" || fail "Cannot allocate staging directory"
    cp -p "$ACTIVE" "$STAGE/current"; [ ! -f "$CURRENT_META" ] || cp -p "$CURRENT_META" "$STAGE/current.meta"; restore_previous
    if ! restart_running; then mv -f "$STAGE/current" "$ACTIVE"; [ ! -f "$STAGE/current.meta" ] || mv -f "$STAGE/current.meta" "$CURRENT_META"; restart_running || message "WARNING: service could not be recovered"; fail "Rollback failed: restored newer core"; fi
    message "Rolled back to previous core (or packaged binary)"
}
start_operation() {
    op="$1"; shift; mkdir -p "$CORE_DIR"; mkdir "$LOCK" 2>/dev/null || fail "Another core operation is running"
    now="$(date +%s)"; tmp="$STATE.tmp.$$"; printf 'state=running\noperation=%s\nstarted=%s\nfinished=\nmessage=\n' "$op" "$now" > "$tmp"; mv -f "$tmp" "$STATE"
    ( sh "$0" __worker "$op" "${1:-}" "${2:-}" </dev/null >> "$LOG" 2>&1 ) >/dev/null 2>&1 &
    printf 'operation=%s\nstate=running\n' "$op"
}
worker() {
    op="$2"; started="$(sed -n 's/^started=//p' "$STATE" 2>/dev/null || echo 0)"
    if [ "$op" = update ]; then sh "$0" __execute update "$3" "$4" || result=$?; else sh "$0" __execute rollback || result=$?; fi
    result="${result:-0}"; now="$(date +%s)"; if [ "$result" -eq 0 ]; then write_state success "$op" "$started" "$now" "completed"; else write_state failed "$op" "$started" "$now" "operation failed"; fi
    [ ! -d "$LOCK" ] || rmdir "$LOCK" 2>/dev/null || :; exit "$result"
}
execute_worker() { CORE_WORKER=1; export CORE_WORKER; trap 'exit 130' INT; trap 'exit 143' TERM; if [ "$2" = update ]; then do_update "$3" "$4"; else do_rollback; fi; }
case "${1:-}" in
 status) status;; log) log_output;; update) do_update "${2:-}" "${3:-}";; rollback) do_rollback;; start-update) variant="$(get_variant "${2:-}")"; tag="${3:-latest}"; validate_tag "$tag"; start_operation update "$variant" "$tag";; start-rollback) start_operation rollback;; __worker) worker "$@";; __execute) execute_worker "$@";; *) message "Usage: $0 {status|log|update [minimal|standard] [latest|TAG]|rollback|start-update VARIANT TAG|start-rollback}"; exit 2;; esac
