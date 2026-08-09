#!/usr/bin/env bash
#
# Verify the artefact a consumer actually installs, rather than the workspace.
#
# Every package here is published from a tarball filtered by `files`, installed into a tree that
# has none of this repo's node_modules, and consumed by a tsc whose moduleResolution we do not
# control. None of that is exercised by `pnpm -r test`, which imports from source. Across eleven
# sibling repositories, essentially every serious defect lived in exactly that gap: a `files` rule
# that omitted a required file, a build that silently emitted nothing, a generated import specifier
# that did not resolve under the consumer's compiler.
#
# So this packs every publishable package, checks each tarball holds what its manifest promises,
# installs them into an empty project, runs the README's headline command, and typechecks the
# emitted tree under every moduleResolution TypeScript still supports.
# The last part is the point: DRZL emits `.js` specifiers precisely so the output compiles under
# node16 and nodenext, and nothing else in CI would notice if that regressed.
#
# Run locally with: pnpm verify:packed
#
# ---------------------------------------------------------------------------------------------
# The shape of this, which used to be one file of 9601 lines.
#
#   scripts/verify-packed.sh          this file: the setup, the stage order, and nothing else
#   scripts/verify/stages/NN-name.sh  one stage each, sourced in numeric order
#   scripts/verify/harness/           the TypeScript and JavaScript the stages run
#   scripts/verify/fixtures/          the schemas and configs the stages generate from
#
# The harnesses were heredocs, which is what made this file 9601 lines and what made the most
# valuable code in the repository the least reviewable: 8000 of those lines were TypeScript inside
# a shell string, with no syntax highlighting, no compiler and no way to open one of them on its
# own. They are real files now and the stages copy them into the throwaway trees.
#
# Stages are *sourced*, in one shell, in order. That is deliberate rather than incidental: they
# share $WORK, $TARS, $APP, $PARITY, $OLD, $NEW and $WORK/printed.log, they leave each other
# directories and installed trees to work in, and several of them depend on the working directory
# the one before it left. A stage that calls `exit 1` still fails the whole run, exactly as it did
# when they were all one file.
# ---------------------------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="$ROOT/scripts/verify"
STAGE_DIR="$VERIFY/stages"
HARNESS="$VERIFY/harness"
FIXTURES="$VERIFY/fixtures"
WORK="$(mktemp -d)"

# Lines a documentation page quotes are recorded here as well as printed, so the stage at the end
# of the run can compare them against what the run actually said. The six database-truth
# harnesses and both parity passes pipe their whole output into this file; a plain echo the docs
# quote has to say so itself, which is what this is for. If a page starts quoting a line that does
# not go through here, that stage fails naming the line rather than passing quietly.
quoted() { printf '%s\n' "$1" | tee -a "$WORK/printed.log"; }
trap 'rm -rf "$WORK"' EXIT

TARS="$WORK/tars"

# The two drizzle-orm versions this gate measures. The defaults are the pinned ones, which is what
# every claim in docs/guide/drizzle-majors.md and docs/guide/comparison.md is stated against. The
# nightly overrides them with whatever `latest` and `rc` serve that day, which is the only way an
# upstream release gets caught on its own schedule rather than on the next pull request.
DRIZZLE_PINS_OVERRIDDEN=0
{ [ -z "${DRIZZLE_0_4X:-}" ] && [ -z "${DRIZZLE_V1:-}" ]; } || DRIZZLE_PINS_OVERRIDDEN=1
DRIZZLE_0_4X="${DRIZZLE_0_4X:-0.45.2}"
DRIZZLE_V1="${DRIZZLE_V1:-1.0.0-rc.4}"

# The stage order, and the only place it is written down. The numeric prefix on each file is what
# orders them on disk; this list is what orders them in a run, and the two are checked against each
# other below, because a stage file nobody runs looks exactly like a stage that passes.
STAGES=(
  prose-counts
  build
  pack
  tarball-contents
  install
  doctor
  explain
  emitted-files
  router-graph
  barrel
  moduleresolution
  dialects
  no-formatter
  documented-configs
  duplicate-finder
  parity-generate
  parity-typecheck
  json-schema-valid
  openapi-valid
  output-size
  parity-run
  ground-truth-pg
  round-trip
  json-schema-truth
  checks-truth
  defaults-truth
  mysql-truth
  sqlite-truth
  majors-install
  majors-describe
  majors-check-old
  parity-0-4x
  registry-deps
  provenance
  docs-numbers
  summary
)

usage() {
  echo "usage: verify-packed.sh [--print-pins] [--list] [--only <stage>[,<stage>...]]" >&2
  echo "       stages, in order:" >&2
  printf '         %s\n' "${STAGES[@]}" >&2
}

# Answering this without running anything is what lets the nightly compare the pins against the
# registry in one cheap job.
if [ "${1:-}" = "--print-pins" ]; then
  printf '%s %s\n' "$DRIZZLE_0_4X" "$DRIZZLE_V1"
  exit 0
fi

# A subset selector, for working on one stage without paying for the ones before it. It is not a
# way to run a shorter gate: most stages read a tree an earlier stage built, and asking for one of
# those on its own fails on the missing tree rather than passing. The two registry stages are the
# ones that hold on their own, since they read the workspace and the registry and nothing else.
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) printf '%s\n' "${STAGES[@]}"; exit 0 ;;
    --only)
      if [ $# -lt 2 ]; then
        echo "verify-packed.sh: --only needs a comma-separated stage list" >&2
        usage
        exit 2
      fi
      ONLY="$2"
      shift 2
      ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    *) echo "verify-packed.sh: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# Every name in the list has a file, and every file is in the list. Both directions, because the
# failure this catches is a stage that stops running while its file sits there looking present.
selected=()
for stage in "${STAGES[@]}"; do
  matches=("$STAGE_DIR"/[0-9][0-9]-"$stage".sh)
  if [ ! -e "${matches[0]}" ]; then
    echo "FAIL: the stage list names '$stage' and $STAGE_DIR holds no NN-$stage.sh." >&2
    exit 1
  fi
  selected+=("${matches[0]}")
done
on_disk=0
for file in "$STAGE_DIR"/[0-9][0-9]-*.sh; do on_disk=$((on_disk + 1)); done
if [ "$on_disk" -ne "${#STAGES[@]}" ]; then
  echo "FAIL: $STAGE_DIR holds $on_disk stage file(s) and the stage list names ${#STAGES[@]}." >&2
  echo "      A stage file that is not in the list is a stage that does not run." >&2
  exit 1
fi

if [ -n "$ONLY" ]; then
  wanted=()
  IFS=',' read -r -a wanted <<< "$ONLY"
  keep=()
  for want in "${wanted[@]}"; do
    found=0
    for i in "${!STAGES[@]}"; do
      if [ "${STAGES[$i]}" = "$want" ]; then
        keep[$i]=1
        found=1
      fi
    done
    if [ "$found" = 0 ]; then
      echo "verify-packed.sh: no such stage: $want" >&2
      usage
      exit 2
    fi
  done
  # In the declared order, whatever order they were asked for in, because the order is the
  # contract between them.
  picked=()
  for i in "${!STAGES[@]}"; do
    if [ "${keep[$i]:-0}" = 1 ]; then picked+=("${selected[$i]}"); fi
  done
  selected=("${picked[@]}")
  echo "==> running ${#selected[@]} of ${#STAGES[@]} stages: $ONLY"
fi

APP="$WORK/consumer"
mkdir -p "$TARS" "$APP/src/db"

# Sourced at the top level rather than from inside a function, so a variable a stage sets is
# visible to the next one, a `cd` in one stage is where the next one starts, and `exit` means exit
# rather than return. Every one of those three is load-bearing somewhere below.
for stage_file in "${selected[@]}"; do
  # shellcheck source=/dev/null
  . "$stage_file"
done
