#!/bin/sh
set -eu

repo_root=${1:?用法：reproduce.sh <NotAlone 主仓路径>}
repo_root=$(cd "$repo_root" && pwd -P)
runner="$repo_root/.scratch/dsh-ts-migration/foreground-location/native-ocr-diagnosis-run.py"
source_file="$(cd "$(dirname "$0")" && pwd -P)/modern-vision-probe.swift"
python="$HOME/miniconda3/envs/NotAlone/bin/python"
test -f "$runner"
test -x "$python"

diagnostic_dir=$(mktemp -d /private/tmp/notalone-21-vision-repro.XXXXXX)
case "$diagnostic_dir" in
  /private/tmp/notalone-21-vision-repro.*) ;;
  *) exit 1 ;;
esac
trap 'rm -rf "$diagnostic_dir"' EXIT HUP INT TERM

xcrun swiftc -O -parse-as-library \
  -framework AppKit -framework CoreGraphics -framework CoreText \
  -framework Vision -framework VisionKit -framework CryptoKit \
  "$source_file" -o "$diagnostic_dir/probe"

for mode in visionkit mismatch visionkit-warm legacy-fast; do
  file="$diagnostic_dir/$mode"
  {
    printf '%s\n' '#!/bin/sh'
    printf 'exec %s "$@"' "$diagnostic_dir/probe"
    case "$mode" in
      visionkit) printf '%s' ' --visionkit' ;;
      mismatch) printf '%s' ' --visionkit --mismatched-fixture' ;;
      visionkit-warm) printf '%s' ' --visionkit-warm' ;;
      legacy-fast) printf '%s' ' --legacy-fast' ;;
    esac
    printf '\n'
  } >"$file"
  chmod 755 "$file"
done

run_case() {
  name=$1
  executable=$2
  printf '\n-- %s --\n' "$name"
  "$python" "$runner" --runner "$executable" --mode direct --timeout-ms 2500
}

set +e
run_case "modern Vision accurate（预期超时）" "$diagnostic_dir/probe"
run_case "VisionKit 正例（预期文字精确）" "$diagnostic_dir/visionkit"
run_case "VisionKit 反例（预期文字不等）" "$diagnostic_dir/mismatch"
run_case "VisionKit 预热后 Vision（预期仍超时）" "$diagnostic_dir/visionkit-warm"
run_case "legacy fast（预期 0 行）" "$diagnostic_dir/legacy-fast"
