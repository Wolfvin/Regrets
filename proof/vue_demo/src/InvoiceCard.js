// InvoiceCard.js — Vue 3 component for regret testing demo
//
// A pure render-function component (no .vue SFC, no build step) that takes
// props and produces deterministic HTML via Vue 3 SSR. This is the canonical
// pattern supported by capture_vue.mjs / validate_vue.mjs in v1.
//
// Props:
//   - invoice: { id: string, amount: number, currency: string }
//   - customer: { name: string, email: string }
//   - status: 'paid' | 'pending' | 'overdue'

import { defineComponent, h } from 'vue'

export const InvoiceCard = defineComponent({
  name: 'InvoiceCard',
  props: {
    invoice: { type: Object, required: true },
    customer: { type: Object, required: true },
    status: { type: String, default: 'pending' },
  },
  setup(props) {
    const statusClass = `status status-${props.status}`
    const formattedAmount = `${props.invoice.currency} ${props.invoice.amount.toFixed(2)}`
    return () => h('div', { class: 'invoice-card' }, [
      h('div', { class: 'invoice-header' }, [
        h('span', { class: 'invoice-id' }, props.invoice.id),
        h('span', { class: statusClass }, props.status.toUpperCase()),
      ]),
      h('div', { class: 'invoice-amount' }, formattedAmount),
      h('div', { class: 'invoice-customer' }, [
        h('div', { class: 'customer-name' }, props.customer.name),
        h('div', { class: 'customer-email' }, props.customer.email),
      ]),
    ])
  },
})

export default InvoiceCard
