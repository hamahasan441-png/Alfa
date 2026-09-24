#!/bin/bash
# The reward is the task's own check — never the agent's claim.
mkdir -p /logs/verifier
if [ "$(cat /app/answer.txt 2>/dev/null)" = "forge was here" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
