#!/usr/bin/env bash
#
# Create the sideload signing key.
#
# It lives in ~/.config/beadcause beside the server token, not in the project, so
# the tree never carries a signing secret. Losing it is not fatal but does mean the
# next APK can't upgrade an installed one in place — Android refuses an update
# signed by a different key, and you'd have to uninstall (losing the pairing) first.
#
set -euo pipefail

KEYSTORE="$HOME/.config/beadcause/android-keystore.jks"
PROPS="$HOME/.config/beadcause/android-keystore.properties"
KEYTOOL="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}/bin/keytool"

if [ -f "$KEYSTORE" ]; then
  echo "keystore already exists: $KEYSTORE"
  echo "delete it by hand if you really mean to replace it — see the note above."
  exit 0
fi

mkdir -p "$(dirname "$KEYSTORE")"
PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)

"$KEYTOOL" -genkeypair -v \
  -keystore "$KEYSTORE" -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -alias beadcause -keyalg RSA -keysize 4096 -validity 10950 \
  -dname "CN=Beadcause, OU=Sideload, O=${BEADCAUSE_KEY_ORG:-$(id -un)}, C=${BEADCAUSE_KEY_COUNTRY:-CA}"

umask 077
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=beadcause\nkeyPassword=%s\n' \
  "$KEYSTORE" "$PASSWORD" "$PASSWORD" > "$PROPS"
chmod 600 "$KEYSTORE" "$PROPS"

echo "created $KEYSTORE"
echo "        $PROPS  (the build reads the password from here)"
