// Significant digits keep tiny amounts readable; cents stay visible on round amounts such as 0.20
export function usd(value, digits = 3) {
  const text = new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits }).format(value);
  return `USD ${(text.split(".")[1]?.length ?? 0) >= 2 ? text : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const count = (value) => value.toLocaleString("en-US");

export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
