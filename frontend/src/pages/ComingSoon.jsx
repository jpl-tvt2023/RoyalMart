import { Construction } from 'lucide-react';
import AppShell from '../components/layout/AppShell';

// Placeholder for outbound features that are scaffolded in the nav but not yet built.
export default function ComingSoon({ title = 'Coming soon' }) {
  return (
    <AppShell>
      <div className="flex flex-col items-center justify-center text-center py-24">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#c1121f]/10 text-[#c1121f]">
          <Construction size={30} />
        </div>
        <h1 className="text-2xl font-bold text-[#003049]">{title}</h1>
        <p className="mt-2 max-w-md text-gray-500 text-sm">
          This is part of the outbound workflow and is coming soon. We&apos;re building it next.
        </p>
      </div>
    </AppShell>
  );
}
