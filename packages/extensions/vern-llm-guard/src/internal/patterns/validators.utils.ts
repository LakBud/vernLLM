/** Mod 97 over the digits of an IBAN, rearranged as the standard says. */
export function ibanValid(raw: string): boolean {
  const iban = raw.replaceAll(' ', '');
  if (iban.length < 15 || iban.length > 34) return false;

  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const code = char.charCodeAt(0);
    // Digits are themselves, letters are 10 to 35.
    const value = code >= 65 ? code - 55 : code - 48;
    remainder = (value < 10 ? remainder * 10 + value : remainder * 100 + value) % 97;
  }
  return remainder === 1;
}

export function luhnValid(raw: string): boolean {
  // The pattern already allows only thirteen to nineteen digits.
  const digits = raw.replaceAll(/[ -]/g, '');

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// A date, or a timestamp that starts with one.
const DATE_LIKE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})(?!\d)/;

export function phoneValid(raw: string): boolean {
  const digits = raw.replaceAll(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  // Plain digits are as likely to be an order number as a phone number.
  if (!raw.startsWith('+') && !/[ ().-]/.test(raw)) return false;
  return !DATE_LIKE.test(raw);
}
