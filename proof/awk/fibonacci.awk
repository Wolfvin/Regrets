# fibonacci.awk — compute the n-th Fibonacci number from stdin.
#
# Input: a single integer n (e.g., "10")
# Output: the n-th Fibonacci number (e.g., "55")
#
# Uses awk's user-defined function `fib` to demonstrate that
# the whole-program model captures the function's I/O contract.

BEGIN {
  getline n
  print fib(n + 0)
}

function fib(n,  a, b, c, i) {
  if (n < 0) return -1
  if (n == 0) return 0
  if (n == 1) return 1
  a = 0; b = 1
  for (i = 2; i <= n; i++) {
    c = a + b
    a = b
    b = c
  }
  return b
}
