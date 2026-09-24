#!/usr/bin/env bash
mkdir -p /logs/verifier
if grep -q "sidecar-says-5829" /app/answer.txt 2>/dev/null; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
