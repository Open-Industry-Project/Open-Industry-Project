#!/usr/bin/env bash
#
# Run the ST external oracles on a Windows checkout, by building the same toolchains CI uses
# inside WSL. Windows has no iec2c, MATIEC needs autoconf/flex/bison/make to build at all, and
# STruC++ ships Linux binaries only - so this is the cheapest way to get a real compiler's
# answer BEFORE a push rather than after one.
#
#   wsl -u root -- bash scripts/oracle-wsl.sh              # MATIEC tier 1, the compile gate
#   wsl -u root -- bash scripts/oracle-wsl.sh --execute    # MATIEC tiers 1 + 2, semantic diff
#   wsl -u root -- bash scripts/oracle-wsl.sh ed3          # STruC++, the 3rd-edition gate
#   wsl -u root -- bash scripts/oracle-wsl.sh ed3 --execute  # ... and build, run and diff what it compiles (g++)
#   wsl -u root -- bash scripts/oracle-wsl.sh all          # both, each with its run tier: what a corpus edit wants
#
# Run it from the repo root: `wsl` maps the Windows working directory to /mnt/c/..., which is
# what makes the relative path above resolve. Each toolchain is built on first use and reused
# after; nothing is fetched for an oracle you did not ask for. Needs a WSL distro with network:
#   wsl --install -d Ubuntu-24.04 --no-launch
#
# The pins are not duplicated here. The MATIEC repo + commit and the STruC++ release tag are
# read out of .github/workflows/st-oracle.yml, because an oracle built differently from CI's
# does not predict CI's result. Move a pin there and the next run rebuilds.
#
# The other two oracle jobs are not here. `st-oracle:xml` (PLCopen TC6 schema)
# and `st-oracle:import` both `import { createServer } from 'vite'`, so they need a Linux
# node_modules - which on /mnt/c is the WINDOWS one, with win32 esbuild/rollup binaries that
# will not load. Supporting them means a second checkout inside WSL that silently drifts from
# the one being edited, and a stale copy answering a conformance question is worse than no
# local answer. They stay in CI. (`st-oracle:xml` does run natively on Windows right up to the
# validation step, and reports what it would have checked, if you want its export half.)
set -euo pipefail

case "$(uname -s)" in
  Linux) ;;
  *) echo "this runs INSIDE WSL: wsl -u root -- bash scripts/oracle-wsl.sh $*" >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo "needs root (apt + /opt): wsl -u root -- bash scripts/oracle-wsl.sh $*" >&2; exit 1; }

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=${OIP_ORACLE_ROOT:-/opt/oip-oracle}
WORKFLOW=$REPO/.github/workflows/st-oracle.yml

# Node is the one version NOT taken from the workflow (which just says "24"): the oracles
# import the corpus straight from TypeScript and rely on native type stripping, so any current
# 24.x will do, and pinning one keeps a rebuild reproducible.
NODE_VER=v24.13.0

WHICH=matiec
case "${1:-}" in
  matiec | ed3 | all) WHICH=$1; shift ;;
esac

pin() { sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" "$WORKFLOW" | head -1 | tr -d '\r'; }
need() { command -v "$1" >/dev/null 2>&1; }

apt_once() {
  # refresh the package index on the first install only
  if [ ! -f "$ROOT/.apt-stamp" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    mkdir -p "$ROOT"
    touch "$ROOT/.apt-stamp"
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq --no-install-recommends "$@"
}

ensure_node() {
  [ -x "$ROOT/node/bin/node" ] && return 0
  echo "==> fetching node $NODE_VER"
  need curl || apt_once ca-certificates curl xz-utils
  mkdir -p "$ROOT/node"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" \
    | tar -xJ -C "$ROOT/node" --strip-components=1
}

ensure_matiec() {
  local repo ref stamp
  repo=$(pin MATIEC_REPO); ref=$(pin MATIEC_REF)
  [ -n "$repo" ] && [ -n "$ref" ] || { echo "could not read MATIEC_REPO/MATIEC_REF from $WORKFLOW" >&2; exit 1; }
  stamp=$ROOT/matiec/.oip-ref
  # keyed on the REF, so moving the pin rebuilds instead of silently replaying the old compiler
  if [ -x "$ROOT/matiec/iec2c" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$ref" ]; then return 0; fi
  echo "==> building MATIEC $ref (first run, or the pin moved)"
  apt_once autoconf automake libtool flex bison build-essential ca-certificates git curl xz-utils
  mkdir -p "$ROOT"
  rm -rf "$ROOT/matiec"
  # not --depth 1 --branch: the pin is a COMMIT, which a shallow branch clone cannot check out.
  # --filter=blob:none keeps it cheap anyway (history without blobs).
  git clone --quiet --filter=blob:none "$repo" "$ROOT/matiec"
  ( cd "$ROOT/matiec" && git checkout --quiet --detach "$ref" && autoreconf -i && ./configure -q && make -s -j"$(nproc)" )
  test -x "$ROOT/matiec/iec2c" || { echo "MATIEC built but produced no iec2c" >&2; exit 1; }
  echo "$ref" > "$stamp"
}

ensure_strucpp() {
  local ver stamp
  ver=$(pin STRUCPP_VERSION)
  [ -n "$ver" ] || { echo "could not read STRUCPP_VERSION from $WORKFLOW" >&2; exit 1; }
  stamp=$ROOT/strucpp/.oip-ref
  if [ -x "$ROOT/strucpp/strucpp" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$ver" ]; then return 0; fi
  echo "==> fetching STruC++ $ver"
  # A PREBUILT release, unlike MATIEC - there is no toolchain to build. CI pulls the same
  # asset through `gh`; a public release download needs no auth, so plain curl is equivalent.
  # GPL-3.0: invoked as a build tool, never linked or vendored.
  need curl || apt_once ca-certificates curl
  rm -rf "$ROOT/strucpp"
  mkdir -p "$ROOT/strucpp"
  curl -fsSL "https://github.com/Autonomy-Logic/STruCpp/releases/download/$ver/strucpp-linux-x64.tar.gz" \
    | tar -xz -C "$ROOT/strucpp" --strip-components=1
  chmod +x "$ROOT/strucpp/strucpp"
  echo "$ver" > "$stamp"
}

# A clean PATH. WSL interop appends the whole Windows PATH, which here contains
# directories with spaces and parentheses ("Program Files (x86)"); leaving it in place breaks
# the first nested quoting this script hands to a subprocess.
export PATH="$ROOT/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd "$REPO"

run_matiec() {
  ensure_node; ensure_matiec
  IEC2C=$ROOT/matiec/iec2c MATIEC_LIB=$ROOT/matiec/lib node scripts/oracle-matiec.mjs "$@"
}
run_ed3() {
  ensure_node; ensure_strucpp
  STRUCPP=$ROOT/strucpp/strucpp node scripts/oracle-strucpp.mjs "$@"
}

case "$WHICH" in
  matiec) run_matiec "$@" ;;
  ed3) run_ed3 "$@" ;;
  all) run_matiec --execute; echo; run_ed3 --execute ;;
esac
