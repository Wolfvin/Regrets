# apache_status_class.awk — classify Apache common-log-format status codes.
#
# Input: lines like:
#   127.0.0.1 - - [10/Oct/2026:13:55:36 -0700] "GET /index.html HTTP/1.1" 200 2326
#   10.0.0.5 - frank [10/Oct/2026:13:55:42 -0700] "POST /login HTTP/1.1" 401 758
#   ...
# Output: for each input line, emit one of {1xx,2xx,3xx,4xx,5xx,INVALID}
#   depending on the HTTP status code field (field 9 in the standard layout).
#
# Idiom: regex match on $9 (status code field). Different from existing
# proof/awk fixtures (which do math on $1 or call user-defined functions).
# This fixture exercises field-aware parsing + conditional dispatch — a
# pattern not covered by sum_column / max_value / word_count.

{
  s = $9
  if (s ~ /^[1-5][0-9][0-9]$/) {
    cls = substr(s, 1, 1) "xx"
    print cls
  } else {
    print "INVALID"
  }
}
