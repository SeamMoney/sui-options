'use client';
import { PhoneFrame, OptionsChain } from '@/components/mobile/OptionsAnalyzer';

export default function Page() {
  return (
    <PhoneFrame>
      <OptionsChain
        highlightStrike={105}
        onBack={() => history.back()}
        onPickContract={() => {}}
      />
    </PhoneFrame>
  );
}
