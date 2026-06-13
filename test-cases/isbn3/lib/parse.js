const fill = require('./fill')
const splitIsbnParts = require('./split_isbn_parts')

/**
 * Normalize an ISBN string by stripping whitespace and hyphens.
 * Hyphens are dropped because they might be incorrectly placed.
 * Ex: only one can be true of 978-88-3282-181-9 and 978-88-328-2181-9
 */
function normalizeIsbnString (value) {
  return value
    .replace(/\s/g, '')
    .replace(/-/g, '')
}

/**
 * Enrich split ISBN parts with metadata: prefix, isIsbn13/isIsbn10 flags.
 */
function enrichParts (data, rawLength) {
  if (rawLength === 13) {
    data.prefix = data.group.length > 0 ? data.source.replace(/[-\s]/g, '').substring(0, 3) : '978'
    data.isIsbn13 = true
    data.isIsbn10 = false
  } else {
    data.isIsbn10 = true
    data.isIsbn13 = false
  }
  return data
}

/**
 * Validate the check digit of enriched ISBN data.
 */
function validateCheckDigit (data) {
  data.isValid = data.check === (data.isIsbn13 ? data.check13 : data.check10)
  return data.isValid ? data : null
}

module.exports = value => {
  if (value == null) return null
  value = value.toString()
  const source = value
  if (!value) return null

  const normalized = normalizeIsbnString(value)
  let data = splitIsbnParts(normalized)

  if (!data) return null

  data.source = source
  data = enrichParts(data, normalized.length)
  data = fill(data)
  if (!data) return null

  return validateCheckDigit(data)
}
