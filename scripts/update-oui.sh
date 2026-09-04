#!/bin/sh
set -eu

destination=${1:-data/oui.csv}
destination_directory=$(dirname "$destination")
mkdir -p "$destination_directory"
temporary_file=$(mktemp "$destination_directory/.oui.csv.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

curl --fail --location --silent --show-error \
  https://standards-oui.ieee.org/oui/oui.csv \
  --output "$temporary_file"
test -s "$temporary_file"
chmod 600 "$temporary_file"
mv "$temporary_file" "$destination"
trap - EXIT HUP INT TERM
echo "Updated $destination from the IEEE MA-L public listing."
