const { parseIndianDate } = require('../../src/parsers/marketplacePO/dates');

describe('parseIndianDate', () => {
  test('ISO date', () => {
    expect(parseIndianDate('2026-07-12')).toBe('2026-07-12');
  });

  test('spelled-out month with time (Blinkit PO date)', () => {
    expect(parseIndianDate('July 12, 2026, 11:35 a.m.')).toBe('2026-07-12');
  });

  test('Django-abbreviated month with period (Blinkit R.O. expiry)', () => {
    expect(parseIndianDate('Aug. 11, 2026, 11:59 p.m.')).toBe('2026-08-11');
    expect(parseIndianDate('Sept. 3, 2026, 9:00 a.m.')).toBe('2026-09-03');
    expect(parseIndianDate('Jan. 1, 2027')).toBe('2027-01-01');
  });

  test('day-first month name, with and without period', () => {
    expect(parseIndianDate('11 Aug 2026')).toBe('2026-08-11');
    expect(parseIndianDate('11 Aug. 2026')).toBe('2026-08-11');
  });

  test('numeric dd-mm-yyyy and dd/mm/yyyy', () => {
    expect(parseIndianDate('21-04-2026')).toBe('2026-04-21');
    expect(parseIndianDate('21/04/2026')).toBe('2026-04-21');
  });

  test('2-digit year (Flipkart Minutes)', () => {
    expect(parseIndianDate('24-06-26')).toBe('2026-06-24');
  });

  test('unparseable input returns null', () => {
    expect(parseIndianDate('')).toBeNull();
    expect(parseIndianDate(null)).toBeNull();
    expect(parseIndianDate('Notamonth 5, 2026')).toBeNull();
  });
});
