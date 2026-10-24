#!/bin/sh
# Safely edit only the ordered nikki-rules array in overrides/rules.yaml.
# Reject concurrent edits using SHA256; config-manager keeps revision backups.
set -eu

HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
FILE="$HOME_DIR/overrides/rules.yaml"
CONFIG_MANAGER="${NIKKI_CONFIG_MANAGER:-$HOME_DIR/scripts/config-manager.sh}"
LOCK="$HOME_DIR/overrides/.rules-edit.lock"

fail() { printf 'rules-manager: %s\n' "$*" >&2; exit 1; }
revision() { sha256sum "$FILE" | cut -d ' ' -f 1; }
validate_file() {
    [ -f "$FILE" ] && [ ! -L "$FILE" ] || fail "Rules module missing or unsafe"
    [ "$(wc -c < "$FILE")" -le 262144 ] || fail "Rules module too large"
    yq -e 'tag == "!!map" and (."nikki-rules" == null or (."nikki-rules" | tag == "!!seq"))' "$FILE" >/dev/null ||
        fail "Rules module must be a YAML mapping with a nikki-rules array"
}
cleanup() {
    [ -z "${STAGING:-}" ] || rm -rf "$STAGING"
    [ ! -d "$LOCK" ] || rmdir "$LOCK" 2>/dev/null || :
}
cmd="${1:-}"
case "$cmd" in
    list)
        [ "$#" -eq 1 ] || fail "Usage: list"
        validate_file
        if yq -r '(."nikki-rules" // [])[] | tag' "$FILE" | grep -qv '^!!str$'; then
            fail "Rules must all be strings"
        fi
        printf '{"revision":"%s","rules":' "$(revision)"
        yq -o=json -I=0 '."nikki-rules" // []' "$FILE" | tr -d '\n'
        printf '}\n'
        ;;
    save)
        [ "$#" -eq 3 ] || fail "Usage: save CANDIDATE_JSON EXPECTED_REVISION"
        candidate="$2"
        expected="$3"
        case "$expected" in *[!0-9a-f]*|'') fail "Invalid revision" ;; esac
        [ "${#expected}" -eq 64 ] || fail "Invalid revision length"
        case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail "Untrusted staging path" ;; esac
        [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail "Candidate missing or unsafe"
        [ "$(wc -c < "$candidate")" -le 262144 ] || fail "Too many rules"
        yq -p=json -o=json -e 'tag == "!!seq"' "$candidate" >/dev/null ||
            fail "Expected JSON array of rules"
        if yq -p=json -o=json -r '.[] | tag' "$candidate" | grep -qv '^!!str$'; then
            fail "Rules must all be strings"
        fi
        expected_count="$(yq -p=json -o=json '. | length' "$candidate")"
        yq -r -p=json -o=json '.[]' "$candidate" | LC_ALL=C awk -v expected="$expected_count" '
          length($0) > 1024 || $0 ~ /[[:cntrl:]]/ { bad = 1 }
          {
              n = split($0, segments, ",")
              if (n < 2 || n > 4) bad = 1
              for (i=1; i<=n; i++) if (segments[i] == "") bad = 1
              if (segments[1] == "MATCH" && n != 2) bad = 1
              if (segments[1] != "MATCH" && n < 3) bad = 1
              if (n == 4 && segments[4] != "no-resolve") bad = 1
              if (n == 3 && segments[3] == "no-resolve") bad = 1
          }
          END { if (NR != expected || bad) exit 1 }
        ' || fail "Invalid rule: TYPE,MATCHER,TARGET[,no-resolve] or MATCH,TARGET"

        mkdir "$LOCK" 2>/dev/null || fail "Another rule edit is in progress"
        STAGING=''
        trap cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        validate_file
        [ "$(revision)" = "$expected" ] || fail "Rules changed on disk: reload before saving"
        STAGING="$(mktemp -d "$HOME_DIR/overrides/.rules-stage.XXXXXX")" ||
            fail "Unable to allocate staging directory"
        yq -M -p=json -o=yaml '{"nikki-rules": .}' "$candidate" > "$STAGING/changes.yaml" ||
            fail "Unable to encode ordered rules"
        yq -M eval-all 'select(fi == 0) * select(fi == 1)' "$FILE" "$STAGING/changes.yaml" > "$STAGING/result.yaml" ||
            fail "Unable to preserve existing YAML fields"
        sh "$CONFIG_MANAGER" save-revision "$FILE" "$STAGING/result.yaml" "$expected" >/dev/null ||
            fail "Versioned rule save failed"
        printf '{"success":true,"revision":"%s"}\n' "$(revision)"
        ;;
    *) fail "Usage: $0 {list|save CANDIDATE_JSON EXPECTED_REVISION}" ;;
esac
