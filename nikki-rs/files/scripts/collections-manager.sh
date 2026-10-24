#!/bin/sh
# Safely edit user-owned Clash-rs collections without replacing subscription data.
set -eu
HOME_DIR="${NIKKI_HOME_DIR:-/etc/nikki-rs}"
MANAGER="${NIKKI_CONFIG_MANAGER:-$HOME_DIR/scripts/config-manager.sh}"
operation="${1:-}"
module="${2:-}"
fail() { printf 'collections-manager: %s\n' "$*" >&2; exit 1; }

case "$module" in
 proxy-groups) key=nikki-proxy-groups; shape=seq ;;
 listeners) key=nikki-listeners; shape=seq ;;
 rule-providers) key=rule-providers; shape=map ;;
 proxy-providers) key=proxy-providers; shape=map ;;
 *) fail UNKNOWN_MODULE ;;
esac
file="$HOME_DIR/overrides/$module.yaml"
[ -f "$file" ] && [ ! -L "$file" ] || fail INVALID_MODULE_FILE
[ "$(wc -c < "$file")" -le 262144 ] || fail MODULE_TOO_LARGE
yq -e 'tag == "!!map"' "$file" >/dev/null 2>&1 || fail INVALID_MODULE_YAML
revision() { sha256sum "$file" | cut -d ' ' -f 1; }
validate_entry() {
 kind="$1"
 item="$2"
 yq -p=json -e 'tag == "!!map" and (.type | tag == "!!str") and (.type | length > 0)' "$item" >/dev/null 2>&1 ||
   fail INVALID_ITEM_TYPE
 case "$kind" in
 proxy-groups)
   yq -p=json -e '
      (.name | tag == "!!str") and (.name | length > 0) and (.name | length <= 128) and
      (.type == "select" or .type == "url-test" or .type == "fallback" or
       .type == "load-balance" or .type == "smart" or .type == "relay") and
      (.proxies == null or ((.proxies | tag) == "!!seq" and (.proxies | length <= 128))) and
      (.use == null or ((.use | tag) == "!!seq" and (.use | length <= 128))) and
      (.interval == null or ((.interval | tag) == "!!int" and .interval >= 1 and .interval <= 86400)) and
      (.tolerance == null or ((.tolerance | tag) == "!!int" and .tolerance >= 0 and .tolerance <= 60000)) and
      (.include-all == null or (.include-all | tag) == "!!bool")
   ' "$item" >/dev/null 2>&1 || fail INVALID_GROUP
   for name in proxies use; do
      if FIELD="$name" yq -p=json -r '.[strenv(FIELD)] // [] | .[] | tag' "$item" |
           grep -qv '^!!str$'; then fail INVALID_MEMBER_LIST; fi
   done
   if yq -p=json -e '.type == "url-test" or .type == "fallback" or .type == "load-balance"' "$item" >/dev/null 2>&1; then
      yq -p=json -e '(.url | tag == "!!str") and (.url | length > 0) and
        (.interval | tag == "!!int") and .interval >= 1' "$item" >/dev/null 2>&1 ||
        fail MISSING_HEALTH_CHECK
   fi ;;
 listeners)
   yq -p=json -e '
      (.name | tag == "!!str") and (.name | length > 0) and (.name | length <= 128) and
      (.port == null or ((.port | tag) == "!!int" and .port >= 1 and .port <= 65535)) and
      (.listen == null or ((.listen | tag) == "!!str" and (.listen | length <= 255)))
   ' "$item" >/dev/null 2>&1 || fail INVALID_LISTENER
   if ! yq -p=json -e '.type == "tun"' "$item" >/dev/null 2>&1; then
      yq -p=json -e '(.port | tag) == "!!int" and .port > 0' "$item" >/dev/null 2>&1 ||
        fail LISTENER_PORT_REQUIRED
   fi ;;
 rule-providers|proxy-providers)
   yq -p=json -e '
      (.type == "http" or .type == "file") and
      (.path | tag == "!!str") and (.path | length > 0) and (.path | length <= 1024) and
      (.interval == null or ((.interval | tag) == "!!int" and .interval >= 1 and .interval <= 604800))
   ' "$item" >/dev/null 2>&1 || fail INVALID_PROVIDER
   if yq -p=json -e '.type == "http"' "$item" >/dev/null 2>&1; then
     yq -p=json -e '(.url | tag == "!!str") and (.url | length > 0) and (.url | length <= 2048)' "$item" >/dev/null 2>&1 ||
       fail PROVIDER_URL_REQUIRED
   fi
   if [ "$kind" = rule-providers ]; then
      yq -p=json -e '.behavior == "domain" or .behavior == "ipcidr" or .behavior == "classical"' "$item" >/dev/null 2>&1 ||
        fail INVALID_RULE_BEHAVIOR
   fi ;;
 esac
}
case "$operation" in
 read)
   [ "$#" -eq 2 ] || fail USAGE_READ
   printf '{"revision":"%s","items":' "$(revision)"
   if [ "$shape" = seq ]; then
     KEY="$key" yq -o=json -I=0 '.[strenv(KEY)] // []' "$file" | tr -d '\n'
   else
     KEY="$key" yq -o=json -I=0 '.[strenv(KEY)] // {}' "$file" | tr -d '\n'
   fi
   printf '}\n' ;;
 save|draft)
   [ "$#" -eq 4 ] || fail USAGE_SAVE
   candidate="$3"; expected="$4"
   case "$candidate" in /tmp/nikki-rs-edit.*|/var/run/nikki-rs/*) ;; *) fail INVALID_CANDIDATE ;; esac
   [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail INVALID_CANDIDATE
   [ "$(wc -c < "$candidate")" -le 262144 ] || fail CANDIDATE_TOO_LARGE
   case "$expected" in *[!0-9a-f]*|'') fail INVALID_REVISION ;; esac
   [ "$(printf '%s' "$expected" | wc -c)" -eq 64 ] || fail INVALID_REVISION
   [ "$(revision)" = "$expected" ] || fail CONFLICT
   if [ "$shape" = seq ]; then
      yq -p=json -e 'tag == "!!seq" and length <= 128' "$candidate" >/dev/null 2>&1 || fail INVALID_ITEMS_ARRAY
   else
      yq -p=json -e 'tag == "!!map" and length <= 128' "$candidate" >/dev/null 2>&1 || fail INVALID_ITEMS_MAP
   fi
   stage="$(mktemp -d /tmp/nikki-rs-collections.XXXXXX)" || fail STAGING_FAILED
   trap 'rm -rf "$stage"' EXIT
   trap 'exit 130' INT
   trap 'exit 143' TERM
   if [ "$shape" = seq ]; then
     yq -p=json -o=json -I=0 '.[]' "$candidate" > "$stage/entries"
     duplicate="$(yq -p=json -r '.[] | .name' "$candidate" | LC_ALL=C sort | uniq -d | head -n 1)"
     [ -z "$duplicate" ] || fail DUPLICATE_NAME
   else
     yq -p=json -o=json -I=0 'to_entries | .[] | .value' "$candidate" > "$stage/entries"
     yq -p=json -r 'keys | .[]' "$candidate" |
        LC_ALL=C awk 'length($0) == 0 || length($0) > 128 || /[[:cntrl:]]/ { bad=1 } END { exit bad ? 1 : 0 }' ||
        fail INVALID_PROVIDER_NAME
   fi
   while IFS= read -r entry; do
      printf '%s\n' "$entry" > "$stage/entry.json"
      validate_entry "$module" "$stage/entry.json"
   done < "$stage/entries"
   cp "$file" "$stage/next.yaml" || fail STAGING_FAILED
   KEY="$key" VALUE="$candidate" yq -i '.[strenv(KEY)] = load(strenv(VALUE))' "$stage/next.yaml" ||
      fail INVALID_STAGED_YAML
   if [ "$operation" = draft ]; then
      cat "$stage/next.yaml"; exit 0
   fi
   sh "$MANAGER" save-revision "$file" "$stage/next.yaml" "$expected" >/dev/null ||
      fail CONFLICT_OR_SAVE_ERROR
   printf '{"success":true,"revision":"%s"}\n' "$(revision)" ;;
 *) fail USAGE_READ_SAVE_DRAFT ;;
esac
