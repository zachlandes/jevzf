#!/bin/sh
# Takes the picker legibility screenshots; see scripts/legibility-shots.mjs
set -eu
cd "$(dirname "$0")/.."
exec node scripts/legibility-shots.mjs "$@"
