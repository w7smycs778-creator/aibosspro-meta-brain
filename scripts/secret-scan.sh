#!/bin/sh
# Secret scan over git index content.
#   scripts/secret-scan.sh         scan staged files (added, copied, modified, renamed)
#   scripts/secret-scan.sh --all   scan every tracked file
# Prints path:line and the matched rule name only, never the matched text.
# Exit 0 clean, 1 findings, 2 usage or git error.
#
# Allowlist (exactly one): lines in src/lib/gateway/meta-dispatcher.ts that
# contain the literal text "Bear"+"er ${" (the API key is read from env at
# runtime). The literal is removed from the line and the remainder is scanned
# again, so any other match on that line is still reported.
#
# Rule strings are split into fragments so this file does not match itself.
set -eu

cd "$(git rev-parse --show-toplevel)" || exit 2

case "${1:-}" in
  "") mode=staged ;;
  --all) mode=all ;;
  *) echo "usage: $0 [--all]" >&2; exit 2 ;;
esac

if [ "$mode" = staged ]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR -z | tr '\0' '\n')
  [ -z "$files" ] && { echo "secret-scan: no staged files"; exit 0; }
else
  files=$(git ls-files -z | tr '\0' '\n')
fi

printf '%s\n' "$files" | perl -e '
  use strict;
  my @rules = (
    ["MODEL_API" . "_KEY=", "MODEL_API" . "_KEY=.{8,}"],
    ["s" . "k-",            "s" . "k-"],
    ["Bear" . "er",         "Bear" . "er "],
    ["pass" . "word",       "pass" . "word"],
    ["crm" . "-v2",         "crm" . "-v2"],
    ["Mart" . "ell",        "Mart" . "ell"],
  );
  $_->[1] = qr/$_->[1]/ for @rules;
  my $allow_path = "src/lib/gateway/meta-dispatcher.ts";
  my $allow_text = "Bear" . "er \${";
  my $hits = 0;
  while (my $path = <STDIN>) {
    chomp $path;
    next if $path eq "";
    open(my $fh, "-|", "git", "show", ":$path") or die "git show failed for $path\n";
    binmode $fh;
    my $n = 0;
    while (my $line = <$fh>) {
      $n++;
      my $scan = $line;
      if ($path eq $allow_path && index($scan, $allow_text) >= 0) {
        $scan =~ s/\Q$allow_text\E//g;
      }
      for my $r (@rules) {
        if ($scan =~ $r->[1]) {
          print "$path:$n: $r->[0]\n";
          $hits++;
        }
      }
    }
    close($fh) or die "git show failed for $path\n";
  }
  if ($hits) { print "secret-scan: $hits finding(s)\n"; exit 1 }
  print "secret-scan: clean\n";
  exit 0;
'
