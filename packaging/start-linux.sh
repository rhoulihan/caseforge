#!/bin/bash
# Start CaseForge. Run this (double-click and "Run", or `./start-linux.sh` in a terminal).
# It opens your web browser automatically.
cd "$(dirname "$0")"
./caseforge serve --app-dir dist
