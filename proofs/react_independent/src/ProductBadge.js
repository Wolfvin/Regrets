// ProductBadge.js — independent React fixture for verifying the React stack
// Uses patterns DIFFERENT from proof/react_demo/InvoiceCard.js to avoid
// confirmation bias (CONTEXT.md "Lesson Learned"):
//   - Function component (not class) — exercises different render path
//   - Multiple prop types (string, number, boolean, array)
//   - Conditional rendering based on boolean prop
//   - Array.map rendering with key prop
//   - Inline style object
//   - Template literal in text content
//
// If validate_react.mjs only works on InvoiceCard's pattern, this fixture
// would expose the gap.

import React from 'react'

export function ProductBadge({ product, showStock = true, tags = [] }) {
  const stockLabel = product.inStock ? 'In Stock' : 'Out of Stock'
  const stockClass = product.inStock ? 'badge-stock-yes' : 'badge-stock-no'
  return React.createElement('div', { className: `product-badge ${stockClass}`, style: { padding: '8px' } }, [
    React.createElement('h3', { key: 'name' }, product.name),
    React.createElement('span', { key: 'price', className: 'price' }, `$${product.price.toFixed(2)}`),
    showStock && React.createElement('span', { key: 'stock', className: 'stock' }, stockLabel),
    tags.length > 0 && React.createElement('ul', { key: 'tags', className: 'tags' },
      tags.map((t, i) => React.createElement('li', { key: `tag-${i}` }, t))
    ),
  ].filter(Boolean))
}

export function StatusPill({ status }) {
  // Maps status code to label — pure function of props
  const labels = { active: 'Active', paused: 'Paused', done: 'Completed' }
  const label = labels[status] || 'Unknown'
  return React.createElement('span', { className: `status-pill status-${status}` }, label)
}

export default ProductBadge
