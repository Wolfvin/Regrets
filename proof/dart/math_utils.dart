/// math_utils.dart — example pure functions for Regrets fingerprint testing

/// Add two integers
int add(int a, int b) => a + b;

/// Multiply two integers
int mul(int a, int b) => a * b;

/// Compute factorial recursively
int factorial(int n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

/// Check if a number is prime
bool isPrime(int n) {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 == 0 || n % 3 == 0) return false;
  int i = 5;
  while (i * i <= n) {
    if (n % i == 0 || n % (i + 2) == 0) return false;
    i += 6;
  }
  return true;
}

/// Reverse a string
String reverseString(String s) => s.split('').reversed.join('');

/// Fibonacci number at position n (0-indexed)
int fibonacci(int n) {
  if (n <= 0) return 0;
  if (n == 1) return 1;
  int a = 0, b = 1;
  for (int i = 2; i <= n; i++) {
    final temp = a + b;
    a = b;
    b = temp;
  }
  return b;
}
