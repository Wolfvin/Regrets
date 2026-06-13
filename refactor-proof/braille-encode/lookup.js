/**
 * Braille encoding lookup tables.
 *
 * The 256-byte mapping uses Unicode Braille patterns (U+2800–U+28FF).
 * Each byte value (0–255) maps to a unique Braille character where
 * the visual dot pattern corresponds to the binary representation.
 *
 * Dot numbering (non-standard, see README for explanation):
 *     8 4
 *     7 3
 *     6 2
 *     5 1
 *
 * Dot significance:
 *    128  8
 *     64  4
 *     32  2
 *     16  1
 */

const BRAILLE_CHARS = (
  '⠀⢀⠠⢠⠐⢐⠰⢰⠈⢈⠨⢨⠘⢘⠸⢸' +
  '⡀⣀⡠⣠⡐⣐⡰⣰⡈⣈⡨⣨⡘⣘⡸⣸' +
  '⠄⢄⠤⢤⠔⢔⠴⢴⠌⢌⠬⢬⠜⢜⠼⢼' +
  '⡄⣄⡤⣤⡔⣔⡴⣴⡌⣌⡬⣬⡜⣜⡼⣼' +
  '⠂⢂⠢⢢⠒⢒⠲⢲⠊⢊⠪⢪⠚⢚⠺⢺' +
  '⡂⣂⡢⣢⡒⣒⡲⣲⡊⣊⡪⣪⡚⣚⡺⣺' +
  '⠆⢆⠦⢦⠖⢖⠶⢶⠎⢎⠮⢮⠞⢞⠾⢾' +
  '⡆⣆⡦⣦⡖⣖⡶⣶⡎⣎⡮⣮⡞⣞⡾⣾' +
  '⠁⢁⠡⢡⠑⢑⠱⢱⠉⢉⠩⢩⠙⢙⠹⢹' +
  '⡁⣁⡡⣡⡑⣑⡱⣱⡉⣉⡩⣩⡙⣙⡹⣹' +
  '⠅⢅⠥⢥⠕⢕⠵⢵⠍⢍⠭⢭⠝⢝⠽⢽' +
  '⡅⣅⡥⣥⡕⣕⡵⣵⡍⣍⡭⣭⡝⣝⡽⣽' +
  '⠃⢃⠣⢣⠓⢓⠳⢳⠋⢋⠫⢫⠛⢛⠻⢻' +
  '⡃⣃⡣⣣⡓⣓⡳⣳⡋⣋⡫⣫⡛⣛⡻⣻' +
  '⠇⢇⠧⢧⠗⢗⠷⢷⠏⢏⠯⢯⠟⢟⠿⢿' +
  '⡇⣇⡧⣧⡗⣗⡷⣷⡏⣏⡯⣯⡟⣟⡿⣿'
).split('')

/** Byte value → Braille character mapping */
export const ENCODE_MAP = BRAILLE_CHARS

/** Braille character → byte value mapping (reverse lookup) */
export const DECODE_MAP = Object.fromEntries(
  Object.entries(ENCODE_MAP).map(([i, ch]) => [ch, i])
)
