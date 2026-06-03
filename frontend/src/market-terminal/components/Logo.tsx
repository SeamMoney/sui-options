export default function Logo({ className = "h-8" }: { className?: string }) {
  return (
    <img
      src="/dailyiq-brand-resources/daily-iq-topbar-logo.svg"
      alt="DailyIQ"
      className={className}
    />
  );
}
