import React from 'react';
import { describe, test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from '../Login';
import { renderWithProviders } from '../../test/renderWithProviders';

describe('Login page', () => {
  test('renders email + password fields and sign-in button', () => {
    renderWithProviders(<Login />);
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  test('password visibility toggle switches input type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Login />);
    const pwd = screen.getByLabelText(/password/i);
    expect(pwd).toHaveAttribute('type', 'password');

    // The eye toggle is the only icon-only button on the form
    const toggles = screen.getAllByRole('button');
    const toggle = toggles.find(b => b.getAttribute('type') === 'button');
    await user.click(toggle);
    expect(pwd).toHaveAttribute('type', 'text');
  });
});
