#!/usr/bin/env bash
mkdir -p /logs/verifier
if [ "$(cat /app/recorded.txt 2>/dev/null)" = "from-the-task-server" ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
