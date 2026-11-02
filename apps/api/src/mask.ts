// Masking for numbers that are shown or recorded but must not be usable (SEC §17.2).

/** "+923001234567" → "+9230•••567": enough to tell numbers apart, not to dial one. */
export function maskPhone(phone: string | null): string | null {
  return phone ? `${phone.slice(0, 5)}•••${phone.slice(-3)}` : null;
}
