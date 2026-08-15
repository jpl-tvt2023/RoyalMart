const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

function isValidDateString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const year = Number(m[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

module.exports = { isValidDateString, MIN_YEAR, MAX_YEAR };
