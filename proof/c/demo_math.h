// demo_math.h — declarations for demo_math.c

#ifndef DEMO_MATH_H
#define DEMO_MATH_H

int demo_add(int a, int b);
long demo_fibonacci(int n);
char* demo_reverse(const char* s);
char** demo_parse_csv_line(const char* line, int* out_count);
char* demo_format_bytes(long bytes);

#endif
