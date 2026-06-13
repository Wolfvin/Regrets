// ESM wrapper for isbn.js (main entry)
import _parse from '../lib/parse.js'
import _audit from '../lib/audit.js'
import _groups from '../lib/groups.js'

const hyphenate = val => {
  const data = _parse(val)
  if (!data) return null
  return data.isIsbn13 ? data.isbn13h : data.isbn10h
}

const asIsbn13 = (val, hyphen) => {
  const data = _parse(val)
  if (!data) return null
  return hyphen ? data.isbn13h : data.isbn13
}

const asIsbn10 = (val, hyphen) => {
  const data = _parse(val)
  if (!data) return null
  if (!data.isbn10) return null
  return hyphen ? data.isbn10h : data.isbn10
}

export { _parse as parse, _audit as audit, hyphenate, asIsbn13, asIsbn10, _groups as groups }
export default { parse: _parse, audit: _audit, hyphenate, asIsbn13, asIsbn10, groups: _groups }
