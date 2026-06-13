const parse = require('./parse')
const calculateCheckDigit = require('./calculate_check_digit')
const getGroup = require('./get_group.js')
const groups = require('./groups.js')
const splitIsbnParts = require('./split_isbn_parts.js')

/**
 * Normalize an ISBN string by keeping only digits and X.
 */
const normalize = input => input.replace(/[^\dX]/g, '')

/**
 * Format a candidate data object for display in clues.
 */
function formatCandidate (candidateData) {
  const { isbn13h, isbn13, isbn10h, isbn10, groupname } = candidateData
  if (isbn10h) {
    return { isbn13h, isbn13, isbn10h, isbn10, groupname }
  } else {
    return { isbn13h, isbn13, groupname }
  }
}

/**
 * Check if the same ISBN with an alternate prefix (978↔979) is valid.
 */
const considerAltPrefix = (normalizedIsbn, altPrefix, clues) => {
  const candidateBase = `${altPrefix}${normalizedIsbn.substring(3, 12)}`
  const checkDigit = calculateCheckDigit(candidateBase)
  const candidateData = parse(`${candidateBase}${checkDigit}`)
  if (candidateData != null) {
    clues.push({ message: 'Possible prefix error', candidate: formatCandidate(candidateData) })
  }
}

/**
 * Check if switching the prefix produces a valid ISBN.
 */
const guessPrefixFromChecksum = (normalizedIsbn, altPrefix, clues) => {
  const altPrefixIsbn = `${altPrefix}${normalizedIsbn.substring(3)}`
  const altPrefixData = parse(altPrefixIsbn)
  if (altPrefixData != null) {
    clues.push({ message: 'Checksum hints different prefix', candidate: formatCandidate(altPrefixData) })
  }
}

/**
 * Check if the ISBN is actually an ISBN-10 with a 978 prefix prepended incorrectly.
 */
const guessUnprefixedFromChecksum = (normalizedIsbn, clues) => {
  const unprefixedIsbn = normalizedIsbn.substring(3)
  const unprefixData = parse(unprefixedIsbn)
  if (unprefixData != null) {
    clues.push({ message: 'Checksum hints that a 978 was added to an ISBN-10 without updating the checksum', candidate: formatCandidate(unprefixData) })
  }
}

/**
 * Check if an ISBN-10 is actually an ISBN-13 missing its prefix.
 */
const guessMissingPrefixFromChecksum = (normalizedIsbn, missingPrefix, clues) => {
  const prefixedIsbn = `${missingPrefix}${normalizedIsbn}`
  const prefixData = parse(prefixedIsbn)
  if (prefixData != null) {
    clues.push({ message: `Checksum hints that it is an ISBN-13 without its ${missingPrefix} prefix`, candidate: formatCandidate(prefixData) })
  }
}

/**
 * Look for possible reasons why an ISBN is invalid.
 * Checks group membership, publisher ranges, and checksum issues.
 */
function lookForPossibleInvalityCauses (normalizedIsbn, clues) {
  const foundGroup = getGroup(normalizedIsbn)
  if (foundGroup) {
    const { groupPrefix } = foundGroup
    const groupInfo = groups[groupPrefix]
    const partsData = splitIsbnParts(normalizedIsbn)
    if (partsData) {
      const candidateBase = normalizedIsbn.slice(0, -1)
      const checkDigit = calculateCheckDigit(candidateBase)
      const candidateData = parse(`${candidateBase}${checkDigit}`)
      const message = "Found a matching group and publisher range, but the checksum didn't match. Could the checksum be wrong?"
      clues.push({ message, candidate: formatCandidate(candidateData) })
    } else {
      clues.push({ message: 'Found a matching group but no matching publisher range', group: { prefix: groupPrefix, name: groupInfo.name } })
    }
  } else {
    clues.push({ message: 'Could not find a matching ISBN group' })
  }

  if (normalizedIsbn.length === 13) {
    if (normalizedIsbn.startsWith('978')) {
      guessPrefixFromChecksum(normalizedIsbn, '979', clues)
      guessUnprefixedFromChecksum(normalizedIsbn, clues)
    } else if (normalizedIsbn.startsWith('979')) {
      guessPrefixFromChecksum(normalizedIsbn, '978', clues)
    }
  } else if (normalizedIsbn.length === 10) {
    guessMissingPrefixFromChecksum(normalizedIsbn, '978', clues)
    guessMissingPrefixFromChecksum(normalizedIsbn, '979', clues)
  }
}

/**
 * Suggest a corrected checksum for an invalid ISBN.
 */
const suggestCorrectChecksum = (normalizedIsbn, clues) => {
  const candidateBase = normalizedIsbn.slice(0, -1)
  const checkDigit = calculateCheckDigit(candidateBase)
  const candidateData = parse(`${candidateBase}${checkDigit}`)
  if (candidateData != null) {
    const message = 'Maybe the problem is the invalid checksum?'
    clues.push({ message, candidate: formatCandidate(candidateData) })
  }
}

// Main audit function (backward compatible: module.exports = function)
const audit = source => {
  if (typeof source !== 'string' || source.length === 0) throw Error(`invalid input: ${source}`)

  const result = { source }
  const data = parse(source)
  result.validIsbn = data != null
  const clues = []
  const normalizedIsbn = normalize(source)

  if (!(normalizedIsbn.length === 13 || normalizedIsbn.length === 10)) throw new Error('invalid input length')

  if (data) {
    result.groupname = data.groupname
    if (normalizedIsbn.length === 13) {
      if (normalizedIsbn.startsWith('978')) considerAltPrefix(normalizedIsbn, '979', clues)
      else if (normalizedIsbn.startsWith('979')) considerAltPrefix(normalizedIsbn, '978', clues)
    }
  } else {
    lookForPossibleInvalityCauses(normalizedIsbn, clues)
  }

  result.clues = clues

  return result
}

// Export main function as default, and internal functions as named exports
module.exports = audit
module.exports.formatCandidate = formatCandidate
module.exports.considerAltPrefix = considerAltPrefix
module.exports.guessPrefixFromChecksum = guessPrefixFromChecksum
module.exports.guessUnprefixedFromChecksum = guessUnprefixedFromChecksum
module.exports.guessMissingPrefixFromChecksum = guessMissingPrefixFromChecksum
module.exports.lookForPossibleInvalityCauses = lookForPossibleInvalityCauses
module.exports.suggestCorrectChecksum = suggestCorrectChecksum
module.exports.normalize = normalize
