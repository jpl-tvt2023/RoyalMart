import { useId } from 'react';

// Type-ahead for a PO's party name. There is no party master table, so `options`
// is just the list of names this vendor has used before (see the /party-names
// lookup). Suggestions only nudge towards a consistent spelling -- any typed text
// is accepted, so a genuinely new party can still be entered and joins the list
// on the next fetch.
//
// Deliberately a native <datalist> rather than a custom dropdown: the Builty grid
// lives inside `overflow-x-auto` (which makes the vertical axis scroll too), so an
// absolutely-positioned menu would be clipped. The browser paints a datalist popup
// outside the page's overflow contexts, so it works in both hosts unchanged.
export default function PartyNameInput({ value, options = [], onChange, className = '', onKeyDown, placeholder = '—' }) {
  const listId = useId();
  return (
    <>
      <input
        type="text"
        list={listId}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
      />
      <datalist id={listId}>
        {options.map(o => <option key={o} value={o} />)}
      </datalist>
    </>
  );
}
