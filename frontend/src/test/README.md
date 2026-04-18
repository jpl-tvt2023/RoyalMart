# Frontend Tests

Component and page tests using **Vitest + React Testing Library + jsdom**.

## Running

```bash
npm install          # first time — installs vitest + RTL
npm test             # single run
npm run test:watch   # watch mode
```

## How it works

- `vite.config.js` has a `test` block enabling jsdom + globals.
- `src/test/setup.js` registers jest-dom matchers and clears state between tests.
- `src/test/renderWithProviders.jsx` wraps components with `AuthProvider` + `MemoryRouter` so pages can be rendered in isolation.
- Sample test: `src/pages/__tests__/Login.test.jsx`.

## What to test

Focus on **behavior users depend on**, not implementation:

- Form validation (Login, ForcePasswordReset, Create User, Create PO)
- Role-gated rendering (sidebar links, PO action buttons per role)
- Conditional UI (critical badges, empty states, loading skeletons)
- Happy-path interactions (mock axios; don't hit the real API)

## Mocking axios

```js
import { vi } from 'vitest';
vi.mock('../../api/client', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));
```

## What NOT to test

- Tailwind class names
- Exact markup structure
- Third-party library internals (react-hot-toast, lucide icons)
