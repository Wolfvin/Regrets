const groups = require('./groups')

const MAX_GROUP_ID_LENGTH = 5

/**
 * Find the registration group for a given ISBN-13 prefix and remaining digits.
 * Searches group IDs from length 0 up to MAX_GROUP_ID_LENGTH.
 */
function findGroup (prefix, restAfterPrefix) {
  let length = 0
  while (length <= MAX_GROUP_ID_LENGTH) {
    const groupId = restAfterPrefix.slice(0, length)
    const groupPrefix = `${prefix}-${groupId}`
    const groupData = groups[groupPrefix]
    if (groupData) return { groupId, groupPrefix, groupData }
    else length++
  }
  return null
}

/**
 * Get the group information for a 13-digit ISBN.
 * Returns group ID, prefix, ranges, and remaining digits after group.
 */
module.exports = isbn13 => {
  const prefix = isbn13.substring(0, 3)
  const restAfterPrefix = isbn13.substring(3)

  // Convert ISBN-10 to ISBN-13 for group lookup
  if (isbn13.length === 10) {
    isbn13 = '978' + isbn13
    return getGroupForIsbn13(isbn13)
  }

  if (isbn13.length === 13) {
    return getGroupForIsbn13(isbn13)
  }

  return null
}

function getGroupForIsbn13 (isbn13) {
  const prefix = isbn13.substring(0, 3)
  const restAfterPrefix = isbn13.substring(3)
  const foundGroup = findGroup(prefix, restAfterPrefix)
  if (!foundGroup) return null
  return {
    group: foundGroup.groupId,
    groupPrefix: foundGroup.groupPrefix,
    ranges: foundGroup.groupData.ranges,
    restAfterGroup: restAfterPrefix.slice(foundGroup.groupId.length)
  }
}
