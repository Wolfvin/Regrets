// ISBN check digit calculation
// Supports ISBN-10 (9-digit base → 1 check digit) and ISBN-13 (12-digit base → 1 check digit)

const ISBN10_BASE_LENGTH = 9
const ISBN13_BASE_LENGTH = 12

function calculateIsbn10CheckDigit (base9) {
  let check = 0
  for (let n = 0; n < ISBN10_BASE_LENGTH; n += 1) {
    check += (10 - n) * base9.charAt(n)
  }
  check = (11 - check % 11) % 11
  return check === 10 ? 'X' : String(check)
}

function calculateIsbn13CheckDigit (base12) {
  let check = 0
  for (let n = 0; n < ISBN13_BASE_LENGTH; n += 2) {
    check += Number(base12.charAt(n)) + 3 * base12.charAt(n + 1)
  }
  return String((10 - check % 10) % 10)
}

module.exports = isbn => {
  if (isbn.length === ISBN10_BASE_LENGTH) {
    return calculateIsbn10CheckDigit(isbn)
  } else if (isbn.length === ISBN13_BASE_LENGTH) {
    return calculateIsbn13CheckDigit(isbn)
  }
  return null
}
