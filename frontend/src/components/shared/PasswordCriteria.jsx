import { Check, X } from 'lucide-react';
import { PASSWORD_RULES } from '../../utils/passwordPolicy';

// Live checklist of the password complexity rules. `password` drives the met/unmet state.
export default function PasswordCriteria({ password = '' }) {
  return (
    <ul className="mt-2 space-y-1">
      {PASSWORD_RULES.map(({ label, test }) => {
        const ok = test(password);
        return (
          <li key={label} className={`flex items-center gap-1.5 text-xs ${ok ? 'text-green-600' : 'text-gray-400'}`}>
            {ok ? <Check size={13} /> : <X size={13} />}
            {label}
          </li>
        );
      })}
    </ul>
  );
}
