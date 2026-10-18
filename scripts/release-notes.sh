#!/bin/sh
# Print the CHANGELOG section for one version: from its "## <version>" heading
# (followed by a space or the end of the line) up to the next "## " heading,
# without leading or trailing blank lines. Prints nothing when there is no such section.
#
#   scripts/release-notes.sh 0.35.56 [CHANGELOG.md]
set -eu
version="$1"
changelog="${2:-CHANGELOG.md}"
awk -v ver="$version" '
  /^## / {
    if (capture) exit
    if ($2 == ver) { capture = 1; next }
  }
  capture {
    # Blank lines are held back until a non-blank one follows, so none
    # lead or trail.
    if ($0 == "") { if (printed) blanks++; next }
    for (; blanks > 0; blanks--) print ""
    print
    printed = 1
  }
' "$changelog"
