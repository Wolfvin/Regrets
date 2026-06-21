<?php declare(strict_types=1);
/**
 * PostFormatter.php — fixture demonstrating the `normalize: ["timestamps"]` rule.
 *
 * The entry function `format_post` calls `date('c')` (non-deterministic),
 * so the captured output would differ on every run unless the timestamps
 * rule masks ISO-8601 strings as <TIMESTAMP> before hashing.
 */

/**
 * Format a blog post into a structured response.
 *
 * @param array{title: string, body: string} $post
 * @return array{title: string, slug: string, published_at: string, summary: string}
 */
function format_post(array $post): array
{
    $title = (string) ($post['title'] ?? '');
    $body  = (string) ($post['body']  ?? '');

    $slug = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $title) ?? '');
    $slug = trim($slug, '-');

    return [
        'title'        => $title,
        'slug'         => $slug,
        'published_at' => date('c'),   // non-deterministic — normalized to <TIMESTAMP>
        'summary'      => strlen($body) > 100 ? substr($body, 0, 100) : $body,
    ];
}
