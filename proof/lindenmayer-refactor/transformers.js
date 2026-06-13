export function stringToObjects (string) {
  if(typeof string !== 'string' && string instanceof String === false) return string;
  let transformed = [];
  for (let symbol of string) transformed.push({symbol});
  return transformed;
}

// TODO: continue here
export function normalizeSuccessorArrays () {

}



/**
 * Normalize the right side of a production.
 * Wraps bare values in {successor: value} structure.
 * Recursively normalizes successors arrays.
 * Optionally converts string successors to object arrays.
 *
 * @param {Object|String} successorDef - The production right side to normalize
 * @param {Boolean} forceObjects - If true, convert string successors to object arrays
 * @returns {Object} Normalized production object
 */
function normalizeSuccessor(successorDef, forceObjects) {
  let normalized = successorDef;

  if (normalized.hasOwnProperty('successors')) {
    for (var i = 0; i < normalized.successors.length; i++) {
      normalized.successors[i] = normalizeSuccessor(normalized.successors[i], forceObjects);
    }
  } else if (!normalized.hasOwnProperty('successor')) {
    normalized = { successor: normalized };
  }

  if (forceObjects && normalized.hasOwnProperty('successor')) {
    normalized.successor = stringToObjects(normalized.successor);
  }

  return normalized;
}

export function normalizeProduction (p, forceObjects) {
  p[1] = normalizeSuccessor(p[1], forceObjects);
  return p;
}
