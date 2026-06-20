// InvoiceCard.js — fixture React component for Regrets capture/validate demo.
//
// Pure presentational component: takes an invoice object + locale, renders
// an HTML card. No hooks, no state, no side effects — ideal fingerprint
// target because the rendered output is fully determined by props.
//
// We use React.createElement (no JSX) so this file can be imported directly
// by capture_react.mjs / validate_react.mjs without a build step. The
// component is the default export AND a named export — capture_react.mjs
// resolves `entry` against both, so either works in the manifest.

import React from 'react'

function formatCurrency(amount, currency) {
  // Format with thousands separator and 2 decimal places. Currency code is
  // appended verbatim (no symbol mapping) so the fingerprint is deterministic
  // regardless of Intl behavior.
  const formatted = Number(amount || 0).toFixed(2)
  const withSep = formatted.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${currency} ${withSep}`
}

function statusLabel(status) {
  // Map internal status codes to human-readable labels. This is the kind of
  // "presentation logic" that makes component-render fingerprinting valuable:
  // a refactor that changes the label set will be caught as a regression.
  switch (status) {
    case 'paid':    return 'Paid'
    case 'unpaid':  return 'Unpaid'
    case 'overdue': return 'Overdue'
    case 'void':    return 'Void'
    default:        return 'Unknown'
  }
}

export function InvoiceCard({ invoice, locale = 'en-US' }) {
  const { id, amount, currency, status, dueDate } = invoice || {}
  const label = statusLabel(status)
  const money = formatCurrency(amount, currency)

  return React.createElement(
    'div',
    { className: `invoice-card invoice-card--${status}`, 'data-invoice-id': id },
    [
      React.createElement('header', { className: 'invoice-card__header', key: 'h' }, [
        React.createElement('span', { className: 'invoice-card__id', key: 'id' }, `Invoice #${id}`),
        React.createElement('span', { className: `invoice-card__status invoice-card__status--${status}`, key: 's' }, label),
      ]),
      React.createElement('dl', { className: 'invoice-card__body', key: 'b' }, [
        React.createElement('dt', { key: 'dt-a' }, 'Amount'),
        React.createElement('dd', { key: 'dd-a' }, money),
        React.createElement('dt', { key: 'dt-d' }, 'Due'),
        React.createElement('dd', { key: 'dd-d' }, dueDate || '—'),
        React.createElement('dt', { key: 'dt-l' }, 'Locale'),
        React.createElement('dd', { key: 'dd-l' }, locale),
      ]),
    ]
  )
}

export default InvoiceCard
