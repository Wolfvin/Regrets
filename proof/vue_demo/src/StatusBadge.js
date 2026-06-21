// StatusBadge.js — Vue 3 component for regret testing demo
//
// Smaller component used to demonstrate that capture_vue.mjs works on
// multiple clusters in a single manifest. Renders a colored status badge.

import { defineComponent, h } from 'vue'

export const StatusBadge = defineComponent({
  name: 'StatusBadge',
  props: {
    label: { type: String, required: true },
    variant: { type: String, default: 'default' },
    size: { type: String, default: 'md' },
  },
  setup(props) {
    return () => h('span', {
      class: `badge badge-${props.variant} badge-${props.size}`,
    }, props.label)
  },
})

export default StatusBadge
