#!/usr/bin/env bash
set -euo pipefail

mcpx_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MCPX_BRIEF=1 bash "$mcpx_script_dir/settings.sh"
