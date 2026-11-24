#!/usr/bin/env bash
#
# signing.sh: sign Mystical.app with a stable local identity, "Mystical Local".
# Sourced by build.sh; `bash macos/signing.sh --check` runs its self-test.
#
# Why: an ad-hoc signature changes with every build, and macOS keys Screen
# Recording and Accessibility to the signature, so every `mystical app` used to
# need both granted again. A self-signed code-signing certificate in the login
# keychain gives every build the same designated requirement (its leaf
# certificate), so the permissions stay. Made once, on the first build; no Apple
# account, no Xcode. Linux and Windows don't need this: neither keys a desktop
# permission to the app's signature.
#
# The key is imported with codesign allowed to use it (-T); macOS still asks the
# first time ("codesign wants to sign using key"). Always Allow means builds
# never ask again. It also means any program running as you can sign something
# as "Mystical Local", and macOS will then treat that thing as Mystical, with its
# Screen Recording and Accessibility: the price of permissions that survive a
# rebuild. Allow (once) asks at every build instead; Deny, or any failure here,
# falls back to ad-hoc, where each build is a new app to macOS.

SIGN_IDENT="Mystical Local"

# sign_keychain: where the identity lives (MYSTICAL_SIGN_KEYCHAIN for tests).
sign_keychain() { echo "${MYSTICAL_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"; }

# ensure_sign_identity: make the certificate and key once. 0 when it's there.
ensure_sign_identity() {
  local kc tmp
  kc="$(sign_keychain)"
  security find-certificate -c "$SIGN_IDENT" "$kc" >/dev/null 2>&1 && return 0
  tmp="$(mktemp -d)" || return 1
  # LibreSSL in /usr/bin: its PKCS#12 is the one `security import` reads.
  if /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$SIGN_IDENT" \
       -addext "basicConstraints=critical,CA:false" \
       -addext "keyUsage=critical,digitalSignature" \
       -addext "extendedKeyUsage=critical,codeSigning" \
       -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1 \
     && /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$SIGN_IDENT" \
       -passout pass:mystical -out "$tmp/id.p12" >/dev/null 2>&1 \
     && security import "$tmp/id.p12" -k "$kc" -P mystical -T /usr/bin/codesign >/dev/null 2>&1; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

# sign_app <bundle>: the stable identity when it can, else ad-hoc. Prints which.
sign_app() {
  local app="$1"
  if ensure_sign_identity \
     && codesign --force --sign "$SIGN_IDENT" --keychain "$(sign_keychain)" "$app" >/dev/null 2>&1; then
    echo "$SIGN_IDENT"
    return 0
  fi
  codesign --force --sign - "$app" >/dev/null 2>&1 || return 1
  echo "ad-hoc"
}

# --check: make the identity in a throwaway keychain, sign two different builds of
# a tiny program, and require the same designated requirement both times. Never
# touches the login keychain. Only when run, never when sourced: a sourced file
# sees its caller's arguments, and `build.sh --check` would otherwise sign the
# real app from the throwaway keychain.
if [ "${BASH_SOURCE[0]}" = "$0" ] && [ "${1:-}" = "--check" ]; then
  set -euo pipefail
  dir="$(mktemp -d)"
  trap 'security delete-keychain "$dir/t.keychain-db" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
  export MYSTICAL_SIGN_KEYCHAIN="$dir/t.keychain-db"
  security create-keychain -p test "$MYSTICAL_SIGN_KEYCHAIN"
  security unlock-keychain -p test "$MYSTICAL_SIGN_KEYCHAIN"
  ensure_sign_identity || { echo "FAIL: couldn't make the identity"; exit 1; }
  ensure_sign_identity || { echo "FAIL: second call should find it"; exit 1; }
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k test "$MYSTICAL_SIGN_KEYCHAIN" >/dev/null
  echo 'int main(void){return 0;}' > "$dir/m.c" && cc "$dir/m.c" -o "$dir/a"
  [ "$(sign_app "$dir/a")" = "$SIGN_IDENT" ] || { echo "FAIL: signed ad-hoc"; exit 1; }
  r1="$(codesign -d -r- "$dir/a" 2>&1 | grep designated)"
  echo 'int main(void){return 1;}' > "$dir/m.c" && cc "$dir/m.c" -o "$dir/a"
  sign_app "$dir/a" >/dev/null
  r2="$(codesign -d -r- "$dir/a" 2>&1 | grep designated)"
  echo "$r1" | grep -q 'certificate leaf' || { echo "FAIL: not keyed to the certificate: $r1"; exit 1; }
  [ "$r1" = "$r2" ] || { echo "FAIL: requirement changed between builds"; exit 1; }
  info="$(codesign -dvv "$dir/a" 2>&1)"
  [[ "$info" == *"Authority=$SIGN_IDENT"* ]] || { echo "FAIL: no authority"; exit 1; }
  echo "ok: same designated requirement across builds ($r1)"
fi
