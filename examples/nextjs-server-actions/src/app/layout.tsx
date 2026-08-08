import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'DRZL: schema to validated server actions',
  description: 'A Drizzle schema, drzl generate, and the emitted zod schemas validating input',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          lineHeight: 1.5,
          margin: '0 auto',
          maxWidth: '48rem',
          padding: '2rem 1rem',
        }}
      >
        {children}
      </body>
    </html>
  );
}
