#!/bin/sh
# Preview copy beside the live site: port 3401, data in <data dir>-preview, same login hash.
#   tmux new-session -d -s assistant-web-preview -c <repo> scripts/serve-preview.sh
# Only one server may own the browser at a time.
AW_PREVIEW=1 exec sh "$(dirname "$0")/serve.sh"
