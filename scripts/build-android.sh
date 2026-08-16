#!/usr/bin/env bash
#
# Build the sideload APK and publish it where the phone can reach it.
#
# There is no Play track and no adb cable in the normal loop: the APK is dropped
# into public/, which the daemon already serves, so installing is "open the URL on
# the phone". The same tailnet that carries the questions carries the app.
#
#   npm run android          # build + publish
#   npm run android -- --install   # also push to an attached/adb-connected device
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
PUBLIC_APK="$ROOT/public/beadcause.apk"

# The toolchain is Homebrew's, not Android Studio's — there is no Studio on this
# machine. JDK 17 because AGP 8.x rejects anything newer as its language level.
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"

if [ ! -d "$ANDROID_HOME/platforms/android-35" ]; then
  echo "error: Android SDK 35 not found at $ANDROID_HOME" >&2
  echo "  brew install --cask android-commandlinetools" >&2
  echo "  sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'" >&2
  exit 1
fi

if [ ! -f "$HOME/.config/beadcause/android-keystore.properties" ]; then
  echo "note: no sideload keystore — falling back to the debug key." >&2
  echo "      npm run android:key   creates one (needed to upgrade in place)." >&2
fi

# Gitignored, because it is a machine-local path. Regenerate it on a fresh clone
# rather than making the first build fail with "SDK location not found".
if [ ! -f "$ANDROID_DIR/local.properties" ]; then
  echo "sdk.dir=$ANDROID_HOME" > "$ANDROID_DIR/local.properties"
  echo "==> wrote android/local.properties (sdk.dir=$ANDROID_HOME)"
fi

# Which build this is. The phone updates itself now (Updater.kt), and it decides
# whether to by comparing the published versionCode against its own — so the number has
# to move with the source and never backwards. The commit count does both: monotonic on
# a branch that only grows, derived from the tree being built rather than from a counter
# somebody has to remember to turn, and the same number twice for the same commit.
#
# A checkout with no git (a tarball) falls back to 1, which is what this always was; such
# a build publishes a sidecar saying so, and a phone reading versionCode 1 concludes it is
# not behind and offers nothing. That is the right answer for a tree nobody can order.
VERSION_CODE=$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)
VERSION_NAME="1.0.$VERSION_CODE"

echo "==> building $VERSION_NAME (versionCode $VERSION_CODE)"
(cd "$ANDROID_DIR" && ./gradlew --quiet :app:assembleRelease \
  "-PbeadcauseVersionCode=$VERSION_CODE" "-PbeadcauseVersionName=$VERSION_NAME")

BUILT="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
[ -f "$BUILT" ] || { echo "error: gradle produced no APK at $BUILT" >&2; exit 1; }

cp "$BUILT" "$PUBLIC_APK"
SIZE=$(du -h "$PUBLIC_APK" | cut -f1)

# The sidecar: what the file cannot say about itself without being parsed.
#
# An APK's versionCode lives in a binary manifest inside a zip, and the daemon has no
# business unpacking one to answer a question the build already knows the answer to. So
# it is written out here, beside the file, and lib/update.js reads it — with the byte
# count as the cross-check that the two describe each other. Written *after* the copy and
# from the copy, so a sidecar can never be newer than the APK it claims to be about.
#
# Gitignored with the APK: it is published, never committed.
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const [apk, code, name] = process.argv.slice(1);
  const buf = fs.readFileSync(apk);
  fs.writeFileSync(apk + ".json", JSON.stringify({
    versionCode: Number(code),
    versionName: name,
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    builtAt: new Date().toISOString(),
  }, null, 2) + "\n");
' "$PUBLIC_APK" "$VERSION_CODE" "$VERSION_NAME"

BASE_URL=$(node "$ROOT/bin/beadcause.js" --url 2>/dev/null | sed 's|/?t=.*||')
echo "==> published $SIZE"
echo "    install on the phone: ${BASE_URL:-http://<tailnet-ip>:4318}/beadcause.apk"

# A build ends where the install begins: on the phone. Nobody should have to type
# a tailnet IP, a port and a path with their thumbs to pick up what was just built.
node -e '
  const url = process.argv[1];
  if (!url.startsWith("http")) process.exit(0);
  require("qrcode-terminal").generate(url, { small: true }, (art) => console.log("\n" + art));
' "${BASE_URL:-none}/beadcause.apk" 2>/dev/null || true

if [ "${1:-}" = "--install" ]; then
  echo "==> adb install"
  "$ANDROID_HOME/platform-tools/adb" install -r "$PUBLIC_APK"
fi
