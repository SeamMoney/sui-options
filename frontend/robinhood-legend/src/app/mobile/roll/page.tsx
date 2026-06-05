'use client';
import { PhoneFrame, RollPage } from '@/components/mobile/OptionsAnalyzer';

const defaultPosition = {
  title: 'STRC $105 Call',
  subtitle: '31 DTE · 4 Buys',
  contracts: 4,
};

export default function Page() {
  return (
    <PhoneFrame>
      <RollPage
        position={defaultPosition}
        onBack={() => history.back()}
        onPickNew={() => {}}
      />
    </PhoneFrame>
  );
}
