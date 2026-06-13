import { ENCODE_MAP, DECODE_MAP } from './lookup.js'

/**
 * Encode a Uint8Array (or any byte array) as a Braille Unicode string.
 * Each byte maps to exactly one Braille character.
 *
 * @param {Uint8Array|Array<number>} uint8Array - The binary data to encode
 * @returns {string} Braille Unicode string
 */
export const encode = uint8Array =>
  uint8Array.reduce((acc, b) => acc + ENCODE_MAP[b], '')

/**
 * Decode a Braille Unicode string back to binary data.
 * Each Braille character maps to exactly one byte.
 *
 * @param {string} str - The Braille string to decode
 * @returns {Uint8Array} Decoded binary data
 * @throws {Error} If the string contains non-Braille characters
 */
export const decode = str =>
  Uint8Array.from(
    str.split('').map(ch => {
      if (!(ch in DECODE_MAP)) {
        throw Error(
          'Cannot decode character U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') +
          " '" + ch + "', not a valid Braille pattern."
        )
      }
      return DECODE_MAP[ch]
    })
  )
