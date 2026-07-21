import { caseFold } from "unicode-case-folding";

// unicode-case-folding follows the newest UCD. Python 3.12 uses Unicode 15.0,
// where these Unicode 16/17 uppercase characters were not assigned yet.
const postUnicode15Singles = new Set([
  0x1c89, 0xa7cb, 0xa7cc, 0xa7ce, 0xa7d2, 0xa7d4, 0xa7da, 0xa7dc,
]);

export function unicodeCaseFold(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) as number;
    if (
      postUnicode15Singles.has(codePoint) ||
      (codePoint >= 0x10d50 && codePoint <= 0x10d65) ||
      (codePoint >= 0x16ea0 && codePoint <= 0x16eb8)
    ) {
      return character;
    }
    return caseFold(character);
  }).join("");
}
