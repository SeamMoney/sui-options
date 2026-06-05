import './globals.css';
import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Robinhood Legend (clone)' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="rh-bw-ds--theme--glass--dark--regular--base background_token(colors.neutral.bg1)">
      <head>
        <link rel="stylesheet" href="/cdn.robinhood.com/assets/generated_assets/black-widow/main.rs1c15ec8af791941c.css" />
        <link rel="stylesheet" href="/tokens.css" />
        <link rel="stylesheet" href="/fontfaces.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
