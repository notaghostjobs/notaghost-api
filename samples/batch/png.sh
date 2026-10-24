#!/bin/bash
# render page 1 (and 2 if present) of every output PDF at low res for a visual pass
cd "$(dirname "$0")"
for f in out/*.pdf; do b=$(basename "$f" .pdf); pdftoppm -r 45 -png "$f" "png/$b"; done
ls png | wc -l
