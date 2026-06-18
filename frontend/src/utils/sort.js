// Case-insensitive, number-aware ascending comparison for dropdown options.
export const cmpText = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });

// Returns a new array sorted ascending by the given accessor (identity by default).
// Use for any entity/name dropdown so options always render A→Z.
export const sortByText = (arr, accessor = (x) => x) =>
  [...(arr || [])].sort((a, b) => cmpText(accessor(a), accessor(b)));
