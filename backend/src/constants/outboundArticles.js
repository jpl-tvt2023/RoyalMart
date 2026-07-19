const CATEGORIES = ['Raw Material', 'Packaging', 'Others'];

// Fixed Item Name choices per Category. 'Others' has no fixed list — the
// caller supplies free text instead.
const ITEM_NAME_OPTIONS = {
  'Raw Material': ['Caps', 'Handkerchief', 'Bandana', 'Socks'],
  'Packaging': ['Corrugated', 'One Ply'],
};

module.exports = { CATEGORIES, ITEM_NAME_OPTIONS };
