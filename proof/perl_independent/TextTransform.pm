package TextTransform;
use strict; use warnings;
use Exporter 'import';
our @EXPORT_OK = qw(slugify title_case count_words reverse_words);

sub slugify {
    my ($str) = @_;
    $str = lc($str);
    $str =~ s/[^a-z0-9]+/-/g;
    $str =~ s/^-+|-+$//g;
    return $str;
}

sub title_case {
    my ($str) = @_;
    return join(' ', map { ucfirst(lc($_)) } split(/\s+/, $str));
}

sub count_words {
    my ($str) = @_;
    return scalar(split(/\s+/, $str));
}

sub reverse_words {
    my ($str) = @_;
    return join(' ', reverse split(/\s+/, $str));
}

1;
