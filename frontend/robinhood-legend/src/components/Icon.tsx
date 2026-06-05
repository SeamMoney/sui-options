import iconsRaw from './icons.json';
const icons = iconsRaw as Record<string, string>;
export function Icon({ name, ...props }: { name: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const svg = icons[name];
  if (!svg) return <span {...props} data-icon-missing={name} />;
  return <span {...props} data-icon={name} dangerouslySetInnerHTML={{ __html: svg }} />;
}
