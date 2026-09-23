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
if ! test -s "$temporary_file"; then
  echo "Downloaded IEEE MA-L CSV is empty; existing database was preserved." >&2
  exit 1
fi
if awk -F, '
  NR == 1 {
    header_ok = ($1 == "Registry" && $2 == "Assignment" && $3 == "Organization Name")
    next
  }
  $1 == "MA-L" && length($2) == 6 && $2 ~ /^[0-9A-Fa-f]+$/ { valid += 1 }
  END {
    if (!header_ok) exit 2
    if (valid < 1000) exit 3
  }
' "$temporary_file"; then
  :
else
  validation_status=$?
  if [ "$validation_status" -eq 2 ]; then
    echo "Downloaded file does not have the IEEE MA-L CSV header; existing database was preserved." >&2
  else
    echo "Downloaded IEEE MA-L CSV has fewer than 1000 valid records; existing database was preserved." >&2
  fi
  exit 1
fi
chmod 600 "$temporary_file"
mv "$temporary_file" "$destination"
trap - EXIT HUP INT TERM
echo "Updated $destination from the IEEE MA-L public listing."
