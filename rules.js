function entitlement(hire, asOf) {
  const start = new Date(hire + 'T00:00:00Z');
  const date = new Date(asOf + 'T00:00:00Z');

  if (!Number.isFinite(+start) ||
      !Number.isFinite(+date) ||
      date < start) {
    return 0;
  }

  function anniversary(years, months = 0) {
    const d = new Date(start);
    d.setUTCDate(1);
    d.setUTCFullYear(start.getUTCFullYear() + years);
    d.setUTCMonth(start.getUTCMonth() + months);

    const lastDay = new Date(Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      0
    )).getUTCDate();

    d.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    return d;
  }

  if (date < anniversary(0, 6)) return 0;

  let years = date.getUTCFullYear() - start.getUTCFullYear();
  if (date < anniversary(years)) years--;

  if (years < 1) return 3;
  if (years < 2) return 7;
  if (years < 3) return 10;
  if (years < 5) return 14;
  if (years < 10) return 15;

  return Math.min(30, 16 + years - 10);
}

module.exports = { entitlement };
