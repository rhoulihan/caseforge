#!/bin/bash
# Double-click this file to start CaseForge. It opens your web browser automatically.
# (First time: if macOS says it's from an unidentified developer, right-click this file → Open.)
cd "$(dirname "$0")"
./caseforge serve --app-dir dist
