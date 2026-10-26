#!/bin/bash
# Run tsc and report only errors in open-sse/executors/
cd /home/code/Project/9router || exit 1
npx tsc --noEmit --pretty false -p tsconfig.json > /tmp/tsc_full.txt 2>&1
LC_ALL=C grep -a "open-sse/executors/" /tmp/tsc_full.txt > /tmp/tsc_exec.txt || true
echo "executor errors: $(LC_ALL=C grep -ac 'open-sse/executors/' /tmp/tsc_full.txt)"
LC_ALL=C grep -a "open-sse/executors/" /tmp/tsc_full.txt | sed 's/(.*//' | sort | uniq -c | sort -rn
