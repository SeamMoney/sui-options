'use client';
import { PhoneFrame, OpenPage } from '@/components/mobile/OptionsAnalyzer';

const defaultPosition = {
  title: 'STRC $105 Call',
};

export default function Page() {
  return (
    <PhoneFrame>
      <OpenPage
        position={defaultPosition}
        onBack={() => history.back()}
      />
    </PhoneFrame>
  );
}
