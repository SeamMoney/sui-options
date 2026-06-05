import { LegendApp } from '@/components/LegendApp';
export default async function LegendLayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LegendApp layoutId={id} />;
}
