#!/bin/sh
# Manage the ordered nikki-rules array while preserving unrelated rules.yaml keys.
# Includes optimistic revision checks to prevent concurrent LuCI tabs clobbering edits.
set -eu
HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
FILE="$HOME_DIR/overrides/rules.yaml"
CONFIG_MANAGER="${NIKKI_CONFIG_MANAGER:-$HOME_DIR/scripts/config-manager.sh}"
LOCK="$HOME_DIR/overrides/.rules-edit.lock"

fail() { printf 'rules-manager: %s\n' "$*" >&2; exit 1; }
revision() { sha256sum "$FILE" | cut -d ' ' -f 1; }
validate_file() {
    [ -f "$FILE" ] && [ ! -L "$FILE" ] || fail "Rules module is missing or a symlink"
    [ "$(wc -c < "$FILE")" -le 262144 ] || fail "Rules module is too large"
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
        # Validate rules are strings before returning a JSON document.
        if yq -r '(."nikki-rules" // [])[] | tag' "$FILE" | grep -qv '^!!str
        printf '{"revision":"%s","rules":' "$(revision)"
        yq -o=json -I=0 '."nikki-rules" // []' "$FILE" | tr -d '\n'
        printf '}\n'
        ;;
    save)
        [ "$#" -eq 3 ] || fail "Usage: save CANDIDATE_JSON EXPECTED_REVISION"
        candidate="$2"
        expected="$3"
        case "$expected" in
            *[!0-9a-f]*|'') fail "Invalid expected revision" ;;
        esac
        [ "${#expected}" -eq 64 ] || fail "Invalid revision length"
        case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail "Untrusted staging path" ;; esac
        [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail "Candidate missing or unsafe"
        [ "$(wc -c < "$candidate")" -le 262144 ] || fail "Too many rules"
        yq -p=json -e 'tag == "!!seq"' "$candidate" >/dev/null ||
            fail "Expected JSON array of rules"
        if yq -p=json -r '.[] | tag' "$candidate" | grep -qv '^!!str
        yq -r -p=json '.[]' "$candidate" | LC_ALL=C awk '
          length($0) > 1024 || $0 ~ /[[:cntrl:]]/ { exit 1 }
          {
              n = split($0, segments, ",")
              if (n < 2 || n > 4) exit 1
              for (i=1; i<=n; i++) if (segments[i] == "") exit 1
              if (segments[1] == "MATCH" && n != 2) exit 1
              if (n == 4 && segments[4] != "no-resolve") exit 1
              if (n == 3 && segments[3] == "no-resolve") exit 1
          }
        ' || fail "Rule format invalid: use TYPE,MATCHER,TARGET[,no-resolve] or MATCH,TARGET"

        mkdir "$LOCK" 2>/dev/null || fail "Another rule operation is in progress"
        STAGING=''
        trap cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        validate_file
        [ "$(revision)" = "$expected" ] || fail "Rule list changed on disk: reload before saving"
        STAGING="$(mktemp -d "$HOME_DIR/overrides/.rules-stage.XXXXXX")" || fail "Unable to create staging area"
        yq -M -p=json -o=yaml '{"nikki-rules": .}' "$candidate" > "$STAGING/changes.yaml" ||
            fail "Unable to encode rule list"
        yq -M eval-all 'select(fi == 0) * select(fi == 1)' "$FILE" "$STAGING/changes.yaml" > "$STAGING/result.yaml" ||
            fail "Unable to apply edited rules"
        # config-manager handles atomic save, validation and revision backups.
        "$CONFIG_MANAGER" save "$FILE" "$STAGING/result.yaml" >/dev/null ||
            fail "Versioned rule save failed"
        printf '{"success":true,"revision":"%s"}\n' "$(revision)"
        ;;
    *) fail "Usage: $0 {list|save CANDIDATE_JSON EXPECTED_REVISION}" ;;
esac
; then
            fail "Rules must be strings"
        fi
        printf '{"revision":"%s","rules":' "$(revision)"
        yq -o=json -I=0 '."nikki-rules" // []' "$FILE" | tr -d '\n'
        printf '}\n'
        ;;
    save)
        [ "$#" -eq 3 ] || fail "Usage: save CANDIDATE_JSON EXPECTED_REVISION"
        candidate="$2"
        expected="$3"
        case "$expected" in
            *[!0-9a-f]*|'') fail "Invalid expected revision" ;;
        esac
        [ "${#expected}" -eq 64 ] || fail "Invalid revision length"
        case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail "Untrusted staging path" ;; esac
        [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail "Candidate missing or unsafe"
        [ "$(wc -c < "$candidate")" -le 262144 ] || fail "Too many rules"
        yq -p=json -e 'tag == "!!seq" and all(.[]; tag == "!!str")' "$candidate" >/dev/null ||
            fail "Expected JSON array of rules"
        yq -r -p=json '.[]' "$candidate" | LC_ALL=C awk '
          length($0) > 1024 || $0 ~ /[[:cntrl:]]/ { exit 1 }
          {
              n = split($0, segments, ",")
              if (n < 2 || n > 4) exit 1
              for (i=1; i<=n; i++) if (segments[i] == "") exit 1
              if (segments[1] == "MATCH" && n != 2) exit 1
              if (n == 4 && segments[4] != "no-resolve") exit 1
              if (n == 3 && segments[3] == "no-resolve") exit 1
          }
        ' || fail "Rule format invalid: use TYPE,MATCHER,TARGET[,no-resolve] or MATCH,TARGET"

        mkdir "$LOCK" 2>/dev/null || fail "Another rule operation is in progress"
        STAGING=''
        trap cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        validate_file
        [ "$(revision)" = "$expected" ] || fail "Rule list changed on disk: reload before saving"
        STAGING="$(mktemp -d "$HOME_DIR/overrides/.rules-stage.XXXXXX")" || fail "Unable to create staging area"
        yq -M -p=json -o=yaml '{"nikki-rules": .}' "$candidate" > "$STAGING/changes.yaml" ||
            fail "Unable to encode rule list"
        yq -M eval-all 'select(fi == 0) * select(fi == 1)' "$FILE" "$STAGING/changes.yaml" > "$STAGING/result.yaml" ||
            fail "Unable to apply edited rules"
        # config-manager handles atomic save, validation and revision backups.
        "$CONFIG_MANAGER" save "$FILE" "$STAGING/result.yaml" >/dev/null ||
            fail "Versioned rule save failed"
        printf '{"success":true,"revision":"%s"}\n' "$(revision)"
        ;;
    *) fail "Usage: $0 {list|save CANDIDATE_JSON EXPECTED_REVISION}" ;;
esac
; then
            fail "Rules must all be strings"
        fi
        expected_count="$(yq -p=json '. | length' "$candidate")"
        actual_count="$(yq -r -p=json '.[]' "$candidate" | awk 'END { print NR }')"
        [ "$expected_count" -eq "$actual_count" ] || fail "Rules must not contain embedded newlines"
        yq -r -p=json '.[]' "$candidate" | LC_ALL=C awk '
          length($0) > 1024 || $0 ~ /[[:cntrl:]]/ { exit 1 }
          {
              n = split($0, segments, ",")
              if (n < 2 || n > 4) exit 1
              for (i=1; i<=n; i++) if (segments[i] == "") exit 1
              if (segments[1] == "MATCH" && n != 2) exit 1
              if (n == 4 && segments[4] != "no-resolve") exit 1
              if (n == 3 && segments[3] == "no-resolve") exit 1
          }
        ' || fail "Rule format invalid: use TYPE,MATCHER,TARGET[,no-resolve] or MATCH,TARGET"

        mkdir "$LOCK" 2>/dev/null || fail "Another rule operation is in progress"
        STAGING=''
        trap cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        validate_file
        [ "$(revision)" = "$expected" ] || fail "Rule list changed on disk: reload before saving"
        STAGING="$(mktemp -d "$HOME_DIR/overrides/.rules-stage.XXXXXX")" || fail "Unable to create staging area"
        yq -M -p=json -o=yaml '{"nikki-rules": .}' "$candidate" > "$STAGING/changes.yaml" ||
            fail "Unable to encode rule list"
        yq -M eval-all 'select(fi == 0) * select(fi == 1)' "$FILE" "$STAGING/changes.yaml" > "$STAGING/result.yaml" ||
            fail "Unable to apply edited rules"
        # config-manager handles atomic save, validation and revision backups.
        "$CONFIG_MANAGER" save "$FILE" "$STAGING/result.yaml" >/dev/null ||
            fail "Versioned rule save failed"
        printf '{"success":true,"revision":"%s"}\n' "$(revision)"
        ;;
    *) fail "Usage: $0 {list|save CANDIDATE_JSON EXPECTED_REVISION}" ;;
esac
; then
            fail "Rules must be strings"
        fi
        printf '{"revision":"%s","rules":' "$(revision)"
        yq -o=json -I=0 '."nikki-rules" // []' "$FILE" | tr -d '\n'
        printf '}\n'
        ;;
    save)
        [ "$#" -eq 3 ] || fail "Usage: save CANDIDATE_JSON EXPECTED_REVISION"
        candidate="$2"
        expected="$3"
        case "$expected" in
            *[!0-9a-f]*|'') fail "Invalid expected revision" ;;
        esac
        [ "${#expected}" -eq 64 ] || fail "Invalid revision length"
        case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail "Untrusted staging path" ;; esac
        [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail "Candidate missing or unsafe"
        [ "$(wc -c < "$candidate")" -le 262144 ] || fail "Too many rules"
        yq -p=json -e 'tag == "!!seq" and all(.[]; tag == "!!str")' "$candidate" >/dev/null ||
            fail "Expected JSON array of rules"
        yq -r -p=json '.[]' "$candidate" | LC_ALL=C awk '
          length($0) > 1024 || $0 ~ /[[:cntrl:]]/ { exit 1 }
          {
              n = split($0, segments, ",")
              if (n < 2 || n > 4) exit 1
              for (i=1; i<=n; i++) if (segments[i] == "") exit 1
              if (segments[1] == "MATCH" && n != 2) exit 1
              if (n == 4 && segments[4] != "no-resolve") exit 1
              if (n == 3 && segments[3] == "no-resolve") exit 1
          }
        ' || fail "Rule format invalid: use TYPE,MATCHER,TARGET[,no-resolve] or MATCH,TARGET"

        mkdir "$LOCK" 2>/dev/null || fail "Another rule operation is in progress"
        STAGING=''
        trap cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        validate_file
        [ "$(revision)" = "$expected" ] || fail "Rule list changed on disk: reload before saving"
        STAGING="$(mktemp -d "$HOME_DIR/overrides/.rules-stage.XXXXXX")" || fail "Unable to create staging area"
        yq -M -p=json -o=yaml '{"nikki-rules": .}' "$candidate" > "$STAGING/changes.yaml" ||
            fail "Unable to encode rule list"
        yq -M eval-all 'select(fi == 0) * select(fi == 1)' "$FILE" "$STAGING/changes.yaml" > "$STAGING/result.yaml" ||
            fail "Unable to apply edited rules"
        # config-manager handles atomic save, validation and revision backups.
        "$CONFIG_MANAGER" save "$FILE" "$STAGING/result.yaml" >/dev/null ||
            fail "Versioned rule save failed"
        printf '{"success":true,"revision":"%s"}\n' "$(revision)"
        ;;
    *) fail "Usage: $0 {list|save CANDIDATE_JSON EXPECTED_REVISION}" ;;
esac
